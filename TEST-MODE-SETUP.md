# Modo de pruebas aislado — La Picá del Benjamín

Esta rama `test-mode` contiene cambios de aplicación para separar pagos de prueba de los pagos reales. No desplegar sobre el servicio de producción.

## Render: crear un servicio de pruebas independiente

1. Crear un servicio web nuevo desde este mismo repositorio, seleccionando la rama `test-mode`.
2. Mantener el servicio de producción conectado a `main`; no cambiar su rama ni sus variables.
3. Crear una base PostgreSQL exclusiva para pruebas y conectar su URL como `DATABASE_URL`. No reutilizar la base de producción.
4. Configurar las variables de entorno del servicio de pruebas:

- `MP_ACCESS_TOKEN_TEST`: token de prueba de Mercado Pago. Debe comenzar con `TEST-`.
- `MP_WEBHOOK_SECRET_TEST`: secreto de firma del webhook de pruebas, obtenido/configurado en Mercado Pago para la aplicación de pruebas.
- `DATABASE_URL`: URL de la base PostgreSQL exclusiva de pruebas.
- `FRONTEND_URL`: URL pública del sitio de pruebas (sin barra final).
- `INITIAL_TEMP_PASSWORD`: contraseña temporal fuerte y única para inicializar la cuenta `maximo` en la base de pruebas.

No copiar `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` ni `DATABASE_URL` de producción al servicio de pruebas. No guardar tokens ni secretos en GitHub, HTML o JavaScript del navegador.

## Flujo de prueba

1. Iniciar sesión en el portal privado del sitio de pruebas con la cuenta administradora `maximo` y cambiar la contraseña temporal.
2. Abrir la tienda desde el acceso “Abrir tienda en modo de prueba”.
3. La tienda añade `modoPrueba=1`; el servidor exige una sesión de superadministrador y utiliza exclusivamente `MP_ACCESS_TOKEN_TEST`.
4. Las órdenes de prueba no se guardan en la tabla de pedidos de la base de datos.
5. La consulta de la orden de prueba vuelve a Mercado Pago con el token TEST y exige la misma sesión administrativa.
6. Configurar el webhook de pruebas en Mercado Pago apuntando a `/api/mercadopago/webhook/test`, usando el secreto `MP_WEBHOOK_SECRET_TEST`.

## Producción

La ruta normal sigue usando `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` y la base de datos de producción. No activar `modoPrueba=1` en enlaces para clientes.

## Verificación previa a cualquier prueba

- Confirmar que el servicio de pruebas tiene una URL distinta de producción.
- Confirmar en Render que `MP_ACCESS_TOKEN_TEST` está configurado y empieza por `TEST-` (sin revelar el valor en logs).
- Confirmar que no existe una variable de token de producción en el servicio de pruebas.
- Hacer un pedido de importe bajo con credenciales/cuentas de prueba oficiales de Mercado Pago.
- Confirmar que el panel de pedidos de producción no recibe el pedido de prueba.

**Importante:** estos cambios de código están en la rama `test-mode`; aún requieren configurar y desplegar el servicio aislado en Render antes de probar. La existencia de un token TEST por sí sola no prueba que Render lo esté usando.
