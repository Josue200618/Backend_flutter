require('dotenv').config();

if (!process.env.JWT_SECRET) {
    throw new Error('Falta JWT_SECRET en el archivo .env');
}

module.exports = {
    key: process.env.JWT_SECRET
};
