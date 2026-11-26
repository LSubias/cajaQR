import base64
import io
import json
import os
import secrets
import sqlite3
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from tempfile import NamedTemporaryFile
from zoneinfo import ZoneInfo

import click

import qrcode
from flask import Flask, Response, abort, g, jsonify, redirect, render_template, request, session, url_for
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash

def local_session_key(instance_path):
    folder = Path(instance_path)
    folder.mkdir(exist_ok=True)
    key_file = folder / "session.key"
    try:
        return key_file.read_bytes()
    except FileNotFoundError:
        with NamedTemporaryFile(dir=folder) as temporary:
            temporary.write(secrets.token_bytes(32))
            temporary.flush()
            try:
                os.link(temporary.name, key_file)
            except FileExistsError:
                pass
        return key_file.read_bytes()


app = Flask(__name__, static_folder="public/static", static_url_path="/static")
deployed = os.environ.get("VERCEL") == "1"
database_url = os.environ.get("CAJA_DATABASE_URL")
app.config.update(MAX_CONTENT_LENGTH=(4 if deployed else 6) * 1024 * 1024, MAX_FORM_MEMORY_SIZE=128 * 1024)
app.secret_key = os.environ.get("CAJA_SESSION_KEY") or (None if deployed else local_session_key(app.instance_path))
app.config["SESSION_COOKIE_SECURE"] = deployed
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
hostname = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL") or os.environ.get("VERCEL_URL")
default_url = f"https://{hostname}" if deployed and hostname else "http://127.0.0.1:5000"
public_url = os.environ.get("CAJA_PUBLIC_URL", default_url).rstrip("/")
Image.MAX_IMAGE_PIXELS = 16_000_000


DEMO_CATEGORIES = {
    "remera.webp": "Remeras",
    "jean.webp": "Pantalones",
    "zapatilla-roja.webp": "Zapatillas",
    "zapatilla-blanca.webp": "Zapatillas",
}


def db():
    if "db" not in g:
        if database_url:
            from postgres import Postgres

            g.db = Postgres(database_url)
            g.db.execute("SET search_path TO cajaqr, pg_catalog")
            return g.db
        if deployed:
            abort(503, "Caja QR todavía no tiene una base configurada.")
        Path(app.instance_path).mkdir(exist_ok=True)
        g.db = sqlite3.connect(Path(app.instance_path) / "caja.sqlite3")
        g.db.row_factory = sqlite3.Row
        g.db.executescript("""
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                unit INTEGER NOT NULL, stock INTEGER NOT NULL CHECK(stock >= 0)
            );
            CREATE TABLE IF NOT EXISTS categories (
                name TEXT NOT NULL UNIQUE, normalized_name TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'seller'))
            );
            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
                items TEXT NOT NULL, total INTEGER NOT NULL,
                receipt BLOB, delivered INTEGER NOT NULL DEFAULT 0,
                verified INTEGER NOT NULL DEFAULT 0,
                canceled INTEGER NOT NULL DEFAULT 0, seller TEXT, sold_on TEXT
            );
        """)
        columns = {row["name"] for row in g.db.execute("PRAGMA table_info(products)")}
        if not {"size", "image", "category"} <= columns:
            migrate_products(g.db)
        sales_columns = {row["name"] for row in g.db.execute("PRAGMA table_info(sales)")}
        migrations = {"canceled": "INTEGER NOT NULL DEFAULT 0", "seller": "TEXT", "sold_on": "TEXT"}
        if migrations.keys() - sales_columns:
            with g.db as connection:
                connection.execute("BEGIN IMMEDIATE")
                sales_columns = {row["name"] for row in connection.execute("PRAGMA table_info(sales)")}
                for column, definition in migrations.items():
                    if column not in sales_columns:
                        connection.execute(f"ALTER TABLE sales ADD COLUMN {column} {definition}")
    return g.db


def migrate_products(connection):
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(products)")}
        for column in ("size", "image", "category"):
            if column not in columns:
                connection.execute(f"ALTER TABLE products ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        if "category" not in columns:
            connection.executemany("INSERT INTO categories VALUES (?, ?) ON CONFLICT DO NOTHING",
                                   [(name, name.casefold()) for name in set(DEMO_CATEGORIES.values())])
            connection.executemany("UPDATE products SET category = ? WHERE image = ?",
                                   [(name, image) for image, name in DEMO_CATEGORIES.items()])



def lock_writes(connection, *tables):
    if database_url:
        connection.lock(*tables)
    else:
        connection.execute("BEGIN IMMEDIATE")


@app.teardown_appcontext
def close_db(error):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


@app.cli.command("crear-usuarios")
def create_users():
    """Crear las cuatro cuentas iniciales sin modificar las existentes."""
    connection = db()
    existing = {row["username"] for row in connection.execute("SELECT username FROM users")}
    credentials = []
    for username, role in (("admin", "admin"), ("vendedor1", "seller"),
                           ("vendedor2", "seller"), ("vendedor3", "seller")):
        if username in existing:
            continue
        secret = os.environ.get("CAJA_PASSWORD") if role == "admin" else None
        secret = secret or secrets.token_urlsafe(12)
        with connection:
            created = connection.execute(
                "INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                (username, generate_password_hash(secret), role),
            ).rowcount
        if created:
            credentials.append((username, secret))
    for username, secret in credentials:
        click.echo(f"{username}  {secret}")
    if not credentials:
        click.echo("Las cuatro cuentas ya existen.")


@app.before_request
def protect_register():
    if deployed and (not database_url or not app.secret_key):
        abort(503, "Caja QR todavía no está configurada para el servidor.")
    username = session.get("username")
    g.user = db().execute("SELECT username, role FROM users WHERE username = ?", (username,)).fetchone() if username else None
    if request.endpoint in {"register", "inventory", "sales_page"} and g.user is None:
        return redirect(url_for("login"))
    if request.endpoint in {"sales", "update_sale", "register_receipt", "products", "sale_qr", "employees", "categories"} and g.user is None:
        return "Iniciá sesión.", 401


def owns_sale(seller):
    return g.user["role"] == "admin" or seller == g.user["username"]


@app.route("/login", methods=["GET", "POST"])
def login():
    error = "La sesión anterior venció. Ingresá nuevamente." if request.args.get("retry") else None
    if request.method == "POST":
        if not valid_csrf():
            return redirect(url_for("login", retry=1), code=303)
        username = request.form.get("username", "").strip().lower()
        user = db().execute("SELECT username, password_hash FROM users WHERE username = ?", (username,)).fetchone()
        if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
            session.clear()
            session["username"] = user["username"]
            return redirect(url_for("register"), code=303)
        error = "Usuario o contraseña incorrectos."
    return render_template("login.html", error=error)


@app.post("/salir")
def logout():
    check_csrf()
    session.clear()
    return redirect(url_for("login"), code=303)


@app.after_request
def private_response(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.context_processor
def csrf_context():
    return {"csrf_token": session.setdefault("csrf_token", secrets.token_urlsafe(32))}


def valid_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
    return bool(expected and secrets.compare_digest(expected.encode(), supplied.encode()))


def check_csrf():
    if not valid_csrf():
        abort(403, "Volvé a abrir la página y reintentá la operación.")


@app.template_filter("money")
def money(cents):
    whole = f"{cents // 100:,}".replace(",", ".")
    return f"${whole},{cents % 100:02d}"


def price_in_cents(value):
    unit = Decimal(value.replace(",", "."))
    if not unit.is_finite() or not 0 < unit <= 100_000_000 or unit * 100 != int(unit * 100):
        raise ValueError
    return int(unit * 100)


@app.get("/stock")
def inventory():
    return render_template("stock.html")


@app.route("/api/categorias", methods=["GET", "POST"])
def categories():
    connection = db()
    if request.method == "GET":
        return jsonify([row["name"] for row in connection.execute(
            "SELECT name FROM categories ORDER BY LOWER(name), name"
        )])
    if g.user["role"] != "admin":
        abort(403, "Solo el administrador puede crear categorías.")
    check_csrf()
    data = request.get_json(silent=True)
    name = data.get("name") if isinstance(data, dict) else None
    name = " ".join(name.split()) if isinstance(name, str) else ""
    if not 1 <= len(name) <= 48 or name.casefold() == "sin categoría":
        abort(400, "Ingresá un nombre de categoría de hasta 48 caracteres.")
    with connection:
        created = connection.execute("INSERT INTO categories VALUES (?, ?) ON CONFLICT DO NOTHING",
                                     (name, name.casefold())).rowcount
        if not created:
            abort(409, "Ya existe una categoría con ese nombre.")
    return jsonify(name=name), 201


@app.route("/api/productos", methods=["GET", "POST"])
def products():
    connection = db()
    if request.method == "GET":
        return jsonify([dict(row) for row in connection.execute("SELECT * FROM products ORDER BY name, id")])
    if g.user["role"] != "admin":
        abort(403, "Solo el administrador puede editar el stock.")
    check_csrf()
    data = request.get_json(silent=True)
    try:
        name = data["name"].strip()
        size = data.get("size", "").strip()
        unit = price_in_cents(data["price"])
        stock = data["stock"]
        product_id = data.get("id")
        category = data.get("category")
        if category is not None and not isinstance(category, str):
            raise ValueError
        if not 1 <= len(name) <= 100 or len(size) > 20 or type(stock) is not int or not 0 <= stock <= 1_000_000:
            raise ValueError
        if product_id is not None and (type(product_id) is not int or not 1 <= product_id <= 2**53 - 1):
            raise ValueError
    except (AttributeError, KeyError, TypeError, ValueError, InvalidOperation):
        abort(400, "Revisá el nombre, el precio y el stock.")
    with connection:
        lock_writes(connection, "products")
        if category and not connection.execute("SELECT 1 FROM categories WHERE name = ?", (category,)).fetchone():
            abort(400, "Elegí una categoría existente.")
        if product_id is None:
            connection.execute("INSERT INTO products(name, unit, stock, size, category) VALUES (?, ?, ?, ?, ?)",
                               (name, unit, stock, size, category or ""))
        else:
            previous = connection.execute("SELECT name, category FROM products WHERE id = ?", (product_id,)).fetchone()
            if previous is None:
                abort(404, "No encontramos ese producto.")
            category = previous["category"] if category is None else category
            expected_stock = data.get("expectedStock")
            updated = connection.execute("""
                UPDATE products SET name = ?, unit = ?, stock = ?, size = ?, category = ?
                WHERE id = ? AND stock = ?
            """, (name, unit, stock, size, category, product_id, expected_stock)).rowcount
            if not updated:
                abort(409, "El stock cambió. Recargá la pantalla antes de guardar.")
            if category != previous["category"]:
                connection.execute("UPDATE products SET category = ? WHERE name = ? AND category = ?",
                                   (category, previous["name"], previous["category"]))
    return "", 204



@app.get("/")
def register():
    return render_template("register.html")


@app.get("/ventas")
def sales_page():
    return render_template("sales.html")


@app.get("/api/empleados")
def employees():
    if g.user["role"] != "admin":
        abort(403)
    return jsonify([row["username"] for row in db().execute("SELECT username FROM users ORDER BY username")])


@app.route("/api/ventas", methods=["GET", "POST"])
def sales():
    connection = db()
    if request.method == "GET":
        rows = connection.execute("""
            SELECT id, token, total, receipt IS NOT NULL AS received, delivered, verified, items, seller, sold_on
            FROM sales WHERE canceled = 0 AND (? OR seller = ?) ORDER BY id DESC
        """, (g.user["role"] == "admin", g.user["username"])).fetchall()
        return jsonify([{key: row[key] for key in row.keys() if key != "token"} | {"items": json.loads(row["items"]), "link": public_url + url_for("buyer", token=row["token"])} for row in rows])
    check_csrf()
    raw = request.get_json(silent=True)
    if not isinstance(raw, list) or not 1 <= len(raw) <= 50:
        abort(400, "Cargá entre 1 y 50 ítems.")
    quantities = {}
    for item in raw:
        if not isinstance(item, dict):
            abort(400, "Formato de ítem incorrecto.")
        product_id, quantity = item.get("id"), item.get("quantity")
        if type(product_id) is not int or not 1 <= product_id <= 2**53 - 1 or type(quantity) is not int or not 1 <= quantity <= 999:
            abort(400, "Revisá la cantidad de cada producto.")
        quantities[product_id] = quantities.get(product_id, 0) + quantity
    items = []
    for product_id, quantity in quantities.items():
        product = connection.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        if product is None or quantity > product["stock"] or quantity > 999:
            abort(409, "Revisá las cantidades disponibles en stock.")
        items.append({"product_id": product_id, "name": product["name"], "size": product["size"],
                      "quantity": quantity, "unit": product["unit"], "category": product["category"]})
    token = secrets.token_urlsafe(24)
    total = sum(item["quantity"] * item["unit"] for item in items)
    with connection:
        sale_id = connection.execute(
            "INSERT INTO sales(token, items, total, seller, sold_on) VALUES (?, ?, ?, ?, ?) RETURNING id",
            (token, json.dumps(items), total, g.user["username"],
             datetime.now(ZoneInfo("America/Argentina/Buenos_Aires")).date().isoformat()),
        ).fetchone()["id"]
        payload = qr_payload(sale_id, token, items, total)
    return jsonify(payload), 201


def qr_payload(sale_id, token, items, total):
    link = public_url + url_for("buyer", token=token)
    with io.BytesIO() as image:
        qrcode.make(link).save(image, format="PNG")
        qr = base64.b64encode(image.getvalue()).decode()
    return {"id": sale_id, "link": link, "qr": qr, "items": items, "total": total}


@app.get("/api/ventas/<int:sale_id>/qr")
def sale_qr(sale_id):
    sale = db().execute("""
        SELECT token, items, total, seller, receipt IS NOT NULL AS received
        FROM sales WHERE id = ? AND canceled = 0
    """, (sale_id,)).fetchone()
    if sale is None or not owns_sale(sale["seller"]):
        abort(404, "No encontramos esa venta.")
    if sale["received"]:
        abort(409, "La venta ya tiene comprobante.")
    return jsonify(qr_payload(sale_id, sale["token"], json.loads(sale["items"]), sale["total"]))


@app.post("/api/ventas/<int:sale_id>/<action>")
def update_sale(sale_id, action):
    check_csrf()
    if action not in {"entregar", "verificar", "cancelar"}:
        abort(404)
    with db() as connection:
        lock_writes(connection, "products", "sales")
        sale = connection.execute(
            """SELECT items, delivered, verified, canceled, seller, receipt IS NOT NULL AS received
               FROM sales WHERE id = ?""", (sale_id,)
        ).fetchone()
        if sale is None or not owns_sale(sale["seller"]):
            abort(404, "No encontramos esa venta.")
        if action == "cancelar":
            if sale["canceled"]:
                return "", 204
            if sale["verified"]:
                abort(409, "El pago de esta venta ya está verificado.")
            if sale["delivered"]:
                for item in json.loads(sale["items"]):
                    changed = connection.execute(
                        "UPDATE products SET stock = stock + ? WHERE id = ?",
                        (item["quantity"], item["product_id"]),
                    ).rowcount
                    if not changed:
                        abort(409, "No se pudo reponer el stock de la venta.")
            connection.execute("UPDATE sales SET canceled = 1 WHERE id = ?", (sale_id,))
            return "", 204
        if sale["canceled"]:
            abort(410, "Esta venta fue cancelada.")
        if not sale["received"]:
            abort(409, "La venta todavía no tiene comprobante.")
        if action == "verificar":
            connection.execute("UPDATE sales SET verified = 1 WHERE id = ?", (sale_id,))
        elif not sale["delivered"]:
            for item in json.loads(sale["items"]):
                quantity = item["quantity"]
                changed = connection.execute("""
                    UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?
                """, (quantity, item["product_id"], quantity)).rowcount
                if not changed:
                    abort(409, f"Stock insuficiente para entregar {item['name']}.")
            connection.execute("UPDATE sales SET delivered = 1 WHERE id = ?", (sale_id,))
    return "", 204


def find_sale(token):
    sale = db().execute(
        "SELECT id, items, total, canceled, receipt IS NOT NULL AS received FROM sales WHERE token = ?", (token,)
    ).fetchone()
    if sale is None:
        abort(404, "No encontramos esa venta.")
    if sale["canceled"]:
        abort(410, "Esta venta fue cancelada.")
    return sale


@app.route("/v/<token>", methods=["GET", "POST"])
def buyer(token):
    sale = find_sale(token)
    error = None
    if request.method == "POST":
        check_csrf()
        if sale["received"]:
            return Response(status=303, headers={"Location": url_for("buyer", token=token)})
        upload = request.files.get("receipt")
        try:
            if upload is None:
                raise ValueError
            with Image.open(upload.stream, formats=["JPEG", "PNG", "WEBP"]) as source:
                if source.width * source.height > Image.MAX_IMAGE_PIXELS:
                    raise ValueError
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((2600, 2600))
                with io.BytesIO() as output:
                    image.save(output, "JPEG", quality=90)
                    receipt = output.getvalue()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            error = "Elegí una captura JPG, PNG o WebP válida."
        else:
            with db() as connection:
                connection.execute("UPDATE sales SET receipt = ? WHERE id = ? AND receipt IS NULL AND canceled = 0",
                                   (receipt, sale["id"]))
            return Response(status=303, headers={"Location": url_for("buyer", token=token)})
    return render_template("buyer.html", sale=sale, items=json.loads(sale["items"]),
                           upload_limit=4 if deployed else 6,
                           token=token, error=error), 400 if error else 200


def receipt_for(sale_id):
    row = db().execute("SELECT receipt FROM sales WHERE id = ?", (sale_id,)).fetchone()
    if not row or row["receipt"] is None:
        abort(404)
    return Response(row["receipt"], mimetype="image/jpeg")


@app.get("/v/<token>/comprobante")
def buyer_receipt(token):
    return receipt_for(find_sale(token)["id"])


@app.get("/api/ventas/<int:sale_id>/comprobante")
def register_receipt(sale_id):
    sale = db().execute("SELECT seller FROM sales WHERE id = ? AND canceled = 0", (sale_id,)).fetchone()
    if sale is None or not owns_sale(sale["seller"]):
        abort(404)
    return receipt_for(sale_id)
