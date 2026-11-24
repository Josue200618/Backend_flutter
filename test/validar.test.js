const test = require('node:test');
const assert = require('node:assert/strict');
const { enteroNoNegativo } = require('../utils/validar');

test('enteroNoNegativo accepts non-negative integers', () => {
    assert.equal(enteroNoNegativo(0, 'El stock'), 0);
    assert.equal(enteroNoNegativo('12', 'El stock'), 12);
});

test('enteroNoNegativo rejects invalid inventory quantities', () => {
    for (const valor of [-1, 1.5, 'abc', Infinity, null, undefined, '']) {
        assert.throws(
            () => enteroNoNegativo(valor, 'El stock'),
            { status: 400 }
        );
    }
});
