"""Cargar productos y talles de prueba sin modificar el stock existente."""
from app import DEMO_CATEGORIES, app, db, lock_writes

CATALOG = [
    ("Remera básica blanca", 18_500, "remera.webp", ("XS", "S", "M", "L", "XL", "XXL")),
    ("Jean azul recto", 42_000, "jean.webp", tuple(map(str, range(36, 53, 2)))),
    ("Zapatilla deportiva roja", 59_900, "zapatilla-roja.webp", tuple(map(str, range(36, 45)))),
    ("Zapatilla urbana blanca", 54_900, "zapatilla-blanca.webp", tuple(map(str, range(36, 45)))),
]


def load_catalog():
    inserted = 0
    with app.app_context(), db() as connection:
        lock_writes(connection, "products")
        for name, price, image, sizes in CATALOG:
            for index, size in enumerate(sizes):
                inserted += connection.execute("""
                    INSERT INTO products(name, unit, stock, size, image, category)
                    SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
                        SELECT 1 FROM products WHERE name = ? AND size = ?
                    )
                """, (name, price * 100, 3 + index % 5, size, image, DEMO_CATEGORIES[image], name, size)).rowcount
    return inserted


if __name__ == "__main__":
    print(f"Variantes de prueba agregadas: {load_catalog()}")
