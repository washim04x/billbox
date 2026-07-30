const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to SQLite database (this will create billbox.db file if it doesn't exist)
const dbPath = path.resolve(__dirname, 'billbox.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Create User/Brand table
        db.run(`
            CREATE TABLE IF NOT EXISTS UserProfile (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                brandName TEXT NOT NULL,
                address TEXT,
                phone TEXT,
                email TEXT
            )
        `);

        // Create Customers table (phone and name combination should ideally be unique, but we'll use a simple id)
        db.run(`
            CREATE TABLE IF NOT EXISTS Customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                address TEXT,
                previousDue REAL DEFAULT 0,
                UNIQUE(name, phone)
            )
        `);

        // Create Bills table
        db.run(`
            CREATE TABLE IF NOT EXISTS Bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customerId INTEGER NOT NULL,
                billDate TEXT NOT NULL,
                subTotal REAL NOT NULL,
                discount REAL DEFAULT 0,
                tax REAL DEFAULT 0,
                previousDue REAL DEFAULT 0,
                grandTotal REAL NOT NULL,
                receivedAmount REAL DEFAULT 0,
                newDueAmount REAL NOT NULL,
                items TEXT NOT NULL, -- Storing items as a JSON string for simplicity
                FOREIGN KEY (customerId) REFERENCES Customers(id)
            )
        `);
    });
}

module.exports = db;
