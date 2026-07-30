const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- USER PROFILE API ---
app.get('/api/profile', (req, res) => {
    db.get('SELECT * FROM UserProfile LIMIT 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || null);
    });
});

app.post('/api/profile', (req, res) => {
    const { brandName, address, phone, email } = req.body;
    db.get('SELECT id FROM UserProfile LIMIT 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            // Update
            db.run(`UPDATE UserProfile SET brandName=?, address=?, phone=?, email=? WHERE id=?`,
                [brandName, address, phone, email, row.id], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Profile updated' });
                });
        } else {
            // Insert
            db.run(`INSERT INTO UserProfile (brandName, address, phone, email) VALUES (?, ?, ?, ?)`,
                [brandName, address, phone, email], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Profile created', id: this.lastID });
                });
        }
    });
});

// --- CUSTOMERS API ---
app.get('/api/customers', (req, res) => {
    db.all('SELECT * FROM Customers', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/customers', (req, res) => {
    const { name, phone, address, previousDue } = req.body;
    const pd = parseFloat(previousDue) || 0;
    db.run(`INSERT INTO Customers (name, phone, address, previousDue) VALUES (?, ?, ?, ?)`,
        [name, phone, address, pd], function(err) {
            if (err) {
                // If unique constraint fails, it's likely they already exist
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Customer with this name and phone already exists.' });
                }
                return res.status(500).json({ error: err.message });
            }
            
            const customerId = this.lastID;
            
            if (pd > 0) {
                const billDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                const items = JSON.stringify([{ name: 'Previous Balance', qty: 1, rate: pd, amount: pd }]);
                
                db.run(`
                    INSERT INTO Bills (customerId, billDate, subTotal, discount, tax, previousDue, grandTotal, receivedAmount, newDueAmount, items)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [customerId, billDate, pd, 0, 0, 0, pd, 0, pd, items], function(billErr) {
                    if (billErr) {
                        console.error('Failed to create opening balance bill', billErr);
                    }
                    res.json({ message: 'Customer added', id: customerId, name, phone, address, previousDue: pd });
                });
            } else {
                res.json({ message: 'Customer added', id: customerId, name, phone, address, previousDue: pd });
            }
        });
});

// --- BILLS API ---
app.get('/api/bills', (req, res) => {
    db.all(`
        SELECT Bills.*, Customers.name as customerName, Customers.phone as customerPhone 
        FROM Bills 
        JOIN Customers ON Bills.customerId = Customers.id
        ORDER BY Bills.id DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/bills', (req, res) => {
    const { customerId, billDate, subTotal, discount, tax, previousDue, grandTotal, receivedAmount, newDueAmount, items } = req.body;
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        // Save bill
        db.run(`
            INSERT INTO Bills (customerId, billDate, subTotal, discount, tax, previousDue, grandTotal, receivedAmount, newDueAmount, items)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [customerId, billDate, subTotal, discount, tax, previousDue, grandTotal, receivedAmount, newDueAmount, JSON.stringify(items)], 
        function(err) {
            if (err) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: err.message });
            }

            const billId = this.lastID;

            // Update customer's due amount
            db.run(`UPDATE Customers SET previousDue = ? WHERE id = ?`, [newDueAmount, customerId], function(err) {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: err.message });
                }
                
                db.run("COMMIT");
                res.json({ message: 'Bill created successfully', billId });
            });
        });
    });
});

// --- DASHBOARD API ---
app.get('/api/dashboard', (req, res) => {
    // We calculate totalBilled by adding the grandTotal - previousDue of all bills
    // PLUS the initial due of every customer.
    // The initial due is the previousDue of their very first bill, or their current previousDue if they have no bills.
    db.get(`
        SELECT 
            (
                SELECT COALESCE(SUM(previousDue), 0) 
                FROM Bills b1 
                WHERE b1.id = (SELECT MIN(id) FROM Bills b2 WHERE b2.customerId = b1.customerId)
            ) + 
            (
                SELECT COALESCE(SUM(previousDue), 0) 
                FROM Customers 
                WHERE id NOT IN (SELECT DISTINCT customerId FROM Bills)
            ) + 
            COALESCE(SUM(grandTotal - previousDue), 0) as totalBilled,
            COALESCE(SUM(receivedAmount), 0) as totalReceived
        FROM Bills
    `, (err, billStats) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.get(`
            SELECT COALESCE(SUM(previousDue), 0) as totalDue
            FROM Customers
        `, (err, customerStats) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                totalBilled: billStats.totalBilled || 0,
                totalReceived: billStats.totalReceived || 0,
                totalDue: customerStats.totalDue || 0
            });
        });
    });
});

// Fallback to index.html for SPA frontend (if requested explicitly without extension)
app.get('*', (req, res) => {
    if (req.accepts('html')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
