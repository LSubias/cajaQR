const page = document.querySelector("main[data-page]")?.dataset.page;
const byId = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const money = (value) => currency.format(value / 100);

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function productName(product) {
  return product.name + (product.size ? " · Talle " + product.size : "");
}

function productLabel(product) {
  const label = element("div", undefined, "product-label");
  if (product.image) {
    const photo = element("img");
    photo.src = "/static/productos/" + encodeURIComponent(product.image);
    photo.alt = "";
    photo.loading = "lazy";
    label.append(photo);
  }
  label.append(element("strong", product.name));
  return label;
}

function action(label, callback, className) {
  const button = element("button", label, className);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

function renderProducts(container, products, selection, buttonLabel, onClick, unavailable, emptyText) {
  const categories = new Map();
  for (const product of products) {
    const category = product.category || "Sin categoría";
    if (!categories.has(category)) categories.set(category, new Map());
    const models = categories.get(category);
    if (!models.has(product.name)) models.set(product.name, []);
    models.get(product.name).push(product);
  }

  const blocks = [];
  const sorted = [...categories].sort(([a], [b]) =>
    Number(a === "Sin categoría") - Number(b === "Sin categoría") || a.localeCompare(b, "es"));
  for (const [category, models] of sorted) {
    const block = element("section", undefined, "product-category");
    block.append(element("h3", category));
    for (const [name, variants] of models) {
      const key = JSON.stringify([category, name]);
      const row = element("div", undefined, "line product-option");
      const select = element("select");
      select.setAttribute("aria-label", "Talle de " + name);
      for (const variant of variants) {
        const option = element("option", (variant.size || "Único") + " · " + variant.stock + " u.");
        option.value = variant.id;
        select.append(option);
      }
      let selected = variants.find((variant) => variant.id === selection.get(key))
        || variants.find((variant) => !unavailable(variant)) || variants[0];
      select.value = selected.id;
      const price = element("span");
      const button = action(buttonLabel, () => {
        selection.set(key, selected.id);
        onClick(selected);
      }, "secondary");
      function update() {
        price.textContent = money(selected.unit);
        button.disabled = unavailable(selected);
      }
      select.addEventListener("change", () => {
        selected = variants.find((variant) => variant.id === Number(select.value));
        selection.set(key, selected.id);
        update();
      });
      update();
      const controls = element("div", undefined, "variant-controls");
      controls.append(price, select);
      if (buttonLabel) controls.append(button);
      row.append(productLabel(variants.find((variant) => variant.image) || variants[0]), controls);
      block.append(row);
    }
    blocks.push(block);
  }
  container.replaceChildren(...(blocks.length ? blocks : [element("p", emptyText)]));
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    if (response.status === 401) location.assign("/login");
    const text = await response.text();
    const detail = new DOMParser().parseFromString(text, "text/html").querySelector("p");
    throw new Error(detail?.textContent || "No se pudo completar la operación.");
  }
  return response.status === 204 ? undefined : response.json();
}

const getProducts = () => api("/api/productos");
const post = (url, data) => api(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content
  },
  body: JSON.stringify(data)
});

function report(error) {
  byId("message").textContent = error.message || error;
}

async function stockPage() {
  const form = byId("product");
  const fields = form?.elements;
  let selected;
  let categoryFilter = null;
  let products = [];
  let categories = [];
  const selection = new Map();

  function reset() {
    selected = undefined;
    form.reset();
    byId("stock-title").textContent = "Agregar producto";
    byId("cancel").hidden = true;
  }

  function renderFilters() {
    const choices = [["Todas", null], ...categories.map((name) => [name, name])];
    if (products.some((product) => !product.category) || categoryFilter === "") {
      choices.push(["Sin categoría", ""]);
    }
    const buttons = choices.map(([label, value]) => {
      const button = action(label, () => {
        categoryFilter = value;
        for (const [index, control] of buttons.entries()) {
          control.setAttribute("aria-pressed", String(choices[index][1] === categoryFilter));
        }
        render();
      }, "category-filter");
      button.setAttribute("aria-controls", "inventory");
      button.setAttribute("aria-pressed", String(value === categoryFilter));
      return button;
    });
    byId("category-list").replaceChildren(...buttons);
  }

  async function refreshInventory() {
    products = await getProducts();
    renderFilters();
    render();
  }

  function render() {
    const visible = categoryFilter === null ? products
      : products.filter((product) => product.category === categoryFilter);
    renderProducts(byId("inventory"), visible, selection, form ? "Editar" : "", (product) => {
      selected = product;
      fields.name.value = product.name;
      fields.category.value = product.category;
      fields.size.value = product.size;
      fields.price.value = (product.unit / 100).toFixed(2);
      fields.stock.value = product.stock;
      byId("stock-title").textContent = "Editar producto";
      byId("cancel").hidden = false;
      fields.name.focus();
    }, () => false, categoryFilter === null
      ? "Todavía no hay productos." : "No hay productos en esta categoría.");
  }

  byId("cancel")?.addEventListener("click", reset);
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const save = form.querySelector("button");
    save.disabled = true;
    try {
      await post("/api/productos", {
        id: selected?.id,
        expectedStock: selected?.stock,
        name: fields.name.value,
        category: fields.category.value,
        size: fields.size.value,
        price: fields.price.value,
        stock: Number(fields.stock.value)
      });
      reset();
      await refreshInventory();
      report("Producto guardado.");
    } catch (error) {
      report(error);
    } finally {
      save.disabled = false;
    }
  });
  const categoryForm = byId("category-form");
  async function loadCategories(value = "") {
    categories = await api("/api/categorias");
    if (!form) return;
    const options = ["", ...categories].map((name) => {
      const option = element("option", name || "Sin categoría");
      option.value = name;
      return option;
    });
    fields.category.replaceChildren(...options);
    fields.category.value = value;
  }

  if (categoryForm) {
    categoryForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = categoryForm.querySelector("button");
      button.disabled = true;
      try {
        const added = await post("/api/categorias", { name: categoryForm.elements.categoryName.value });
        await loadCategories(added.name);
        renderFilters();
        categoryForm.reset();
        report("Categoría creada.");
      } catch (error) {
        report(error);
      } finally {
        button.disabled = false;
      }
    });
  }
  await loadCategories();
  await refreshInventory();
}

function saleBreakdown(sale) {
  const summary = element("div", undefined, "stack");
  for (const item of sale.items) {
    const line = element("div", undefined, "line");
    line.append(element("span", item.quantity + " × " + productName(item)),
      element("strong", money(item.quantity * item.unit)));
    summary.append(line);
  }
  const total = element("div", undefined, "total");
  total.append(element("span", "Total de la venta"), element("strong", money(sale.total)));
  summary.append(total);
  return summary;
}

function hideQr() {
  const qr = byId("qr");
  qr.hidden = true;
  delete qr.dataset.saleId;
}

function setQrStatus(received) {
  const status = byId("qr").querySelector(".qr-status");
  const label = received ? "Comprobante recibido" : "Esperando comprobante";
  if (status.textContent !== label) status.textContent = label;
}

function showQr(sale) {
  const image = element("img");
  image.src = "data:image/png;base64," + sale.qr;
  image.alt = "Código QR de la venta " + sale.id;
  const link = element("a", "Abrir venta #" + sale.id);
  link.href = new URL(sale.link).pathname;
  const qr = byId("qr");
  const code = element("div", undefined, "sale-qr");
  const historyLink = element("a", "Ver venta en el historial");
  historyLink.href = "/ventas#sale-" + sale.id;
  code.append(image, link);
  if (page === "register") code.append(historyLink);
  const content = element("div", undefined, "qr-layout");
  content.append(saleBreakdown(sale), code);
  const back = action(page === "register" ? "Volver al carrito" : "Cerrar QR", () => {
    hideQr();
    if (page === "register") byId("search").focus();
  }, "secondary");
  qr.replaceChildren(element("h2", "Venta #" + sale.id), content, element("p", undefined, "qr-status"), back);
  setQrStatus(false);
  qr.dataset.saleId = sale.id;
  qr.hidden = false;
  qr.scrollIntoView({ block: "nearest" });
}

const categoryColors = {
  Pantalones: "#00796f",
  Remeras: "#e0aa55",
  Zapatillas: "#638dc0",
  "Sin categoría": "#a383ac"
};

function salesDistribution(counts, units) {
  const card = element("section", undefined, "metric-card distribution");
  card.append(element("h3", "Unidades por tipo"));
  if (!units) {
    card.append(element("p", "Todavía sin datos."));
    return card;
  }

  const ring = element("div", undefined, "sales-ring");
  ring.setAttribute("aria-hidden", "true");
  const center = element("div", undefined, "sales-ring-center");
  center.append(element("strong", units), element("span", "unidades"));
  ring.append(center);
  const legend = element("ul", undefined, "sales-legend");
  const segments = [];
  let cumulative = 0;
  const share = new Intl.NumberFormat("es-AR", { style: "percent", maximumFractionDigits: 1 });
  const extraColors = ["#815746", "#7650a0", "#566b35", "#ba6554", "#456f83"];
  let colorIndex = 0;
  for (const [category, count] of counts) {
    const color = Object.hasOwn(categoryColors, category)
      ? categoryColors[category] : extraColors[colorIndex++ % extraColors.length];
    const start = 100 * cumulative / units;
    cumulative += count;
    segments.push(color + " " + start + "% " + (100 * cumulative / units) + "%");

    const item = element("li");
    const swatch = element("span", undefined, "legend-swatch");
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, element("span", category),
      element("strong", count + " u. · " + share.format(count / units)));
    legend.append(item);
  }
  ring.style.backgroundImage = "conic-gradient(" + segments.join(", ") + ")";
  card.append(ring, legend);
  return card;
}

function renderDashboard(sales, products) {
  const verified = sales.filter((sale) => sale.verified);
  const categories = new Map(products.map(({ id, category }) => [id, category]));
  const byModel = new Map();
  const byCategory = new Map();
  const bySize = new Map();
  let units = 0;
  let revenue = 0;
  for (const sale of verified) {
    revenue += sale.total;
    for (const item of sale.items) {
      const category = (item.category ?? categories.get(item.product_id)) || "Sin categoría";
      units += item.quantity;
      byModel.set(item.name, (byModel.get(item.name) || 0) + item.quantity);
      byCategory.set(category, (byCategory.get(category) || 0) + item.quantity);
      if (item.size) {
        const label = category + " · " + item.size;
        bySize.set(label, (bySize.get(label) || 0) + item.quantity);
      }
    }
  }

  const metrics = [
    ["Ventas verificadas", verified.length],
    ["Unidades vendidas", units],
    ["Total verificado", money(revenue)]
  ].map(([label, value]) => {
    const card = element("div", undefined, "metric-card");
    card.append(element("span", label), element("strong", value));
    return card;
  });
  byId("sales-metrics").replaceChildren(...metrics);

  const rankings = [
    ["Modelos más vendidos", byModel],
    ["Talles más vendidos", bySize]
  ].map(([title, counts]) => {
    const card = element("section", undefined, "metric-card ranking-card");
    card.append(element("h3", title));
    const top = Array.from(counts)
      .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB, "es"))
      .slice(0, 5);
    if (!top.length) {
      card.append(element("p", "Todavía sin datos."));
      return card;
    }
    const list = element("ol", undefined, "ranking");
    for (const [index, [name, count]] of top.entries()) {
      const row = element("li");
      row.append(element("span", name), element("strong", count + " u."));
      const track = element("span", undefined, "ranking-track");
      const bar = element("span", undefined, "ranking-bar");
      bar.style.backgroundColor = ["#00796f", "#638dc0", "#e0aa55", "#a383ac", "#87a597"][index];
      bar.setAttribute("aria-hidden", "true");
      bar.style.width = (100 * count / top[0][1]) + "%";
      track.append(bar);
      row.append(track);
      list.append(row);
    }
    card.append(list);
    return card;
  });
  byId("sales-rankings").replaceChildren(salesDistribution(byCategory, units), ...rankings);
  renderSalesReports(verified);
}

function renderSalesReports(verified) {
  const employeeTotals = new Map();
  const dailyTotals = new Map();
  for (const sale of verified) {
    for (const [totals, key] of [[employeeTotals, sale.seller || "Sin asignar"],
                                [dailyTotals, sale.sold_on || ""]]) {
      if (!totals.has(key)) totals.set(key, { count: 0, amount: 0 });
      const summary = totals.get(key);
      summary.count += 1;
      summary.amount += sale.total;
    }
  }

  const formatDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeZone: "UTC" });
  const rowsByEmployee = [...employeeTotals].sort(([nameA, a], [nameB, b]) =>
    b.count - a.count || b.amount - a.amount || nameA.localeCompare(nameB, "es"));
  const rowsByDate = [...dailyTotals].sort(([a], [b]) => b.localeCompare(a))
    .map(([date, summary]) => [date ? formatDate.format(new Date(date + "T00:00:00Z")) : "Sin fecha registrada", summary]);

  for (const [id, label, rows] of [
    ["employee-report", "Empleado", rowsByEmployee],
    ["daily-report", "Día de la venta", rowsByDate]
  ]) {
    const container = byId(id);
    if (!rows.length) {
      container.replaceChildren(element("p", "Todavía sin ventas verificadas."));
      continue;
    }
    const table = element("table", undefined, "report-table");
    const headings = table.createTHead().insertRow();
    for (const title of [label, "Ventas", "Importe"]) {
      const heading = element("th", title);
      heading.scope = "col";
      headings.append(heading);
    }
    const body = table.createTBody();
    for (const [name, summary] of rows) {
      const row = body.insertRow();
      const heading = element("th", name);
      heading.scope = "row";
      row.append(heading, element("td", summary.count), element("td", money(summary.amount)));
    }
    container.replaceChildren(table);
  }
}

async function salesPage() {
  const employee = byId("employee");
  const products = employee ? await getProducts() : [];
  let latestSales = [];
  function updateDashboard() {
    if (!employee) return;
    let unassigned = employee.querySelector('option[value="unassigned"]');
    if (!unassigned && latestSales.some((sale) => !sale.seller)) {
      unassigned = element("option", "Sin asignar");
      unassigned.value = "unassigned";
      employee.append(unassigned);
    }
    const filtered = employee.value
      ? latestSales.filter((sale) => (sale.seller || "unassigned") === employee.value)
      : latestSales;
    renderDashboard(filtered, products);
  }
  if (employee) {
    const usernames = await api("/api/empleados");
    for (const username of usernames) {
      const option = element("option", username);
      option.value = username;
      employee.append(option);
    }
    employee.addEventListener("change", updateDashboard);
  }
  async function refreshSales() {
    const sales = await api("/api/ventas");
    latestSales = sales;
    const qr = byId("qr");
    if (qr.dataset.saleId && !sales.some((sale) => String(sale.id) === qr.dataset.saleId)) {
      hideQr();
    }
    const container = byId("sales");
    const open = new Set(Array.from(container.querySelectorAll("details[open]"), ({ id }) => id));
    const focusedSale = location.hash.slice(1);
    if (!container.dataset.snapshot && focusedSale) open.add(focusedSale);
    const rows = sales.map((sale) => {
      const row = element("details");
      row.id = "sale-" + sale.id;
      row.open = open.has(row.id);
      row.append(element("summary", "#" + sale.id + " · " + money(sale.total) + " · " +
        (sale.received ? "Comprobante recibido" : "Esperando comprobante") + " · " +
        (sale.delivered ? "Entregada" : "Pendiente de entrega") + " · " +
        (sale.verified ? "Pago verificado" : "Pago pendiente de verificar") +
        (employee ? " · " + (sale.seller || "Sin asignar") : "")));
      const body = element("div", undefined, "stack sale-detail");
      const link = element("a", "Abrir página de la venta");
      link.href = new URL(sale.link).pathname;
      const buyerLink = element("a", "Enlace para el celular");
      buyerLink.href = sale.link;
      body.append(saleBreakdown(sale), link, buyerLink);
      if (sale.received) {
        const receipt = element("a", "Ver comprobante");
        receipt.href = "/api/ventas/" + sale.id + "/comprobante";
        receipt.target = "_blank";
        receipt.rel = "noopener";
        body.append(receipt);
        const buttons = element("div", undefined, "actions");
        for (const [done, label, endpoint] of [
          [sale.delivered, "Registrar entrega y descontar stock", "entregar"],
          [sale.verified, "Marcar pago verificado", "verificar"]
        ]) {
          if (done) continue;
          const button = action(label, async () => {
            button.disabled = true;
            try {
              await post("/api/ventas/" + sale.id + "/" + endpoint, {});
              await refreshSales();
              report(endpoint === "entregar"
                ? "Entrega registrada. Stock actualizado."
                : "Pago verificado." + (sale.delivered ? "" : " La entrega sigue pendiente."));
            } catch (error) {
              report(error);
              button.disabled = false;
            }
          }, "secondary");
          buttons.append(button);
        }
        body.append(buttons);
      }
      if (!sale.received) {
        const regenerate = action("Regenerar QR", async () => {
          regenerate.disabled = true;
          try {
            showQr(await api("/api/ventas/" + sale.id + "/qr"));
          } catch (error) {
            report(error);
          } finally {
            regenerate.disabled = false;
          }
        }, "secondary");
        body.append(regenerate);
      }
      if (!sale.verified) {
        const cancel = action("Cancelar venta", async () => {
          const detail = sale.delivered ? " Se devolverán al stock las unidades de esta venta." : "";
          if (!window.confirm("¿Cancelar la venta #" + sale.id + "?" + detail)) return;
          cancel.disabled = true;
          try {
            await post("/api/ventas/" + sale.id + "/cancelar", {});
            await refreshSales();
            report("Venta #" + sale.id + " cancelada.");
          } catch (error) {
            report(error);
            cancel.disabled = false;
          }
        }, "secondary cancel-sale");
        body.append(cancel);
      }
      row.append(body);
      return row;
    });
    const snapshot = JSON.stringify(sales);
    if (snapshot !== container.dataset.snapshot) {
      container.dataset.snapshot = snapshot;
      container.replaceChildren(...(rows.length ? rows : [element("p", "Todavía no hay ventas.")]));
      updateDashboard();
    }
  }

  await refreshSales();
  async function poll() {
    try {
      await refreshSales();
    } catch (error) {
      report(error);
    } finally {
      setTimeout(poll, 3000);
    }
  }
  setTimeout(poll, 3000);
  const focusedSale = document.getElementById(location.hash.slice(1));
  focusedSale?.scrollIntoView({ block: "nearest" });
}

async function registerPage() {
  let products = [];
  let creating = false;
  const cart = new Map();
  const selection = new Map();
  const search = byId("search");
  const create = byId("create");

  function change(id, amount) {
    const current = cart.get(id) || 0;
    const next = current + amount;
    const product = products.find((entry) => entry.id === id);
    if (next < 0 || (amount > 0 && next > Math.min(product.stock, 999))) return;
    if (next === 0) cart.delete(id);
    else cart.set(id, next);
    renderCart();
  }

  function renderCart() {
    const term = search.value.trim().toLocaleLowerCase("es");
    const entries = products.filter((product) => productName(product).toLocaleLowerCase("es").includes(term));
    renderProducts(byId("catalog"), entries, selection, "Agregar",
      (product) => change(product.id, 1),
      (product) => creating || (cart.get(product.id) || 0) >= Math.min(product.stock, 999),
      "No hay productos para mostrar.");
    let total = 0;
    const lines = Array.from(cart, ([id, quantity]) => {
      const product = products.find((entry) => entry.id === id);
      const row = element("div", undefined, "line");
      const remove = action("−", () => change(id, -1), "secondary");
      remove.setAttribute("aria-label", "Quitar una unidad de " + product.name);
      remove.disabled = creating;
      row.append(element("span", quantity + " × " + productName(product)),
        element("strong", money(quantity * product.unit)), remove);
      total += quantity * product.unit;
      return row;
    });
    byId("cart").replaceChildren(...(lines.length ? lines : [element("p", "Agregá productos para cobrar.")]));
    byId("total").textContent = money(total);
    create.disabled = creating || cart.size === 0;
  }

  search.addEventListener("input", renderCart);
  create.addEventListener("click", async () => {
    creating = true;
    renderCart();
    try {
      const sale = await post("/api/ventas", Array.from(cart, ([id, quantity]) => ({ id, quantity })));
      showQr(sale);
      cart.clear();
      report("QR generado para la venta #" + sale.id + ".");
    } catch (error) {
      report(error);
      getProducts().then((latest) => { products = latest; renderCart(); }).catch(report);
    } finally {
      creating = false;
      renderCart();
    }
  });

  products = await getProducts();
  renderCart();
  const qr = byId("qr");
  setInterval(async () => {
    if (!qr.dataset.saleId) return;
    const id = qr.dataset.saleId;
    try {
      const sales = await api("/api/ventas");
      if (qr.dataset.saleId !== id) return;
      const sale = sales.find((entry) => String(entry.id) === id);
      if (!sale) hideQr();
      else setQrStatus(sale.received);
    } catch (error) {
      report(error);
    }
  }, 3000);
}

if (page === "register") registerPage().catch(report);
if (page === "sales") salesPage().catch(report);
if (page === "stock") stockPage().catch(report);

const goBack = byId("go-back");
if (goBack) {
  goBack.addEventListener("click", () => {
    if (history.length > 1) {
      history.back();
    } else {
      byId("back-message").textContent = "Podés cerrar esta pestaña para salir de la venta.";
    }
  });
}
