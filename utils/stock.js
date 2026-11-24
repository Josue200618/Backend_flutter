const { httpError } = require('./validar');

function acumular(detalles) {
    const acumulado = new Map();

    for (const item of detalles) {
        const actual = acumulado.get(item.producto_id) || 0;
        acumulado.set(item.producto_id, actual + Number(item.cantidad));
    }

    return [...acumulado.entries()].sort((a, b) => a[0] - b[0]);
}

async function sumarStock(client, detalles) {
    for (const [productoId, cantidad] of acumular(detalles)) {
        const resultado = await client.query(
            'UPDATE api_products SET stock = stock + $1 WHERE id = $2',
            [cantidad, productoId]
        );

        if (!resultado.rowCount) {
            throw httpError(400, `El producto ${productoId} no existe`);
        }
    }
}

async function restarStock(client, detalles) {
    for (const [productoId, cantidad] of acumular(detalles)) {
        const bloqueado = await client.query(
            'SELECT id, nombre, stock FROM api_products WHERE id = $1 FOR UPDATE',
            [productoId]
        );

        if (!bloqueado.rows[0]) {
            throw httpError(400, `El producto ${productoId} no existe`);
        }

        if (bloqueado.rows[0].stock < cantidad) {
            throw httpError(400, `Stock insuficiente para ${bloqueado.rows[0].nombre}`);
        }

        await client.query(
            'UPDATE api_products SET stock = stock - $1 WHERE id = $2',
            [cantidad, productoId]
        );
    }
}

module.exports = {
    sumarStock,
    restarStock
};
