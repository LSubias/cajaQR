# Caja QR

Sistema de caja e inventario para ventas pagadas por transferencia.

1. Ingresá a la caja y cargá los productos, precios y unidades en **Stock**.
2. Armá el carrito en **Caja** y tocá **Generar QR**.
3. El comprador hace la transferencia, escanea el QR y adjunta la captura en la página de la venta.
4. La caja consulta los comprobantes cada tres segundos. Desde **Ventas**, podés abrir la captura, marcar el pago como verificado o registrar la entrega.
5. Al marcar la venta como entregada, el sistema descuenta las unidades en una sola transacción. Las ventas pendientes no reservan stock.

El enlace único de cada venta permite ver el detalle y su comprobante sin ingresar a la caja. Compartilo con el comprador de esa venta. La confirmación de la transferencia es manual.

## Prueba local

Con Python 3.12 y el módulo `venv` disponibles:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
CAJA_PASSWORD='elegí-tu-contraseña' .venv/bin/python -m flask --app app crear-usuarios
.venv/bin/python -m flask --app app run
```

El comando inicial crea `admin`, `vendedor1`, `vendedor2` y `vendedor3` e imprime sus contraseñas una vez. Las cuentas existentes se conservan. Abrí http://127.0.0.1:5000. El botón **Abrir venta** permite probar el recorrido del comprador en la misma computadora.

Para escanear el QR con el celular, conectá ambos equipos a la misma red de confianza y reiniciá la app con la IP local de la computadora:

```bash
CAJA_PUBLIC_URL='http://192.168.1.20:5000' \
  .venv/bin/python -m flask --app app run --host 0.0.0.0
```

El prototipo guarda ventas, productos y comprobantes en SQLite dentro de `instance/`. La integración con el proyecto Supabase compartido y el despliegue con HTTPS quedan pendientes.

## Catálogo de prueba

Ejecutá `.venv/bin/python demo_catalog.py` para agregar las variantes de ejemplo a la base local. Los precios y las cantidades son ficticios. Cada variante tiene su propio stock. Si un nombre y talle ya existen, se conserva ese registro.

Fotos de muestra de Unsplash: [remera](https://unsplash.com/photos/white-crew-neck-t-shirt-acn5ERAeSb4), [jean](https://images.unsplash.com/photo-1542272604-787c3835535d), [zapatilla roja](https://images.unsplash.com/photo-1542291026-7eec264c27ff) y [zapatilla blanca](https://images.unsplash.com/photo-1600269452121-4f2416e55c28).

## Reportes y permisos

El administrador edita el stock y ve todas las ventas. Los vendedores consultan el stock y gestionan sus propias ventas. El panel general y el filtro por empleado usan ventas con pago verificado. El día se registra al crear la venta en horario de Buenos Aires. Las ventas previas a la incorporación de cuentas quedan sin empleado ni fecha registrados.
