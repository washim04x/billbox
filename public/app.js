const API_BASE = '/api';
let currentProfile = null;
let currentCustomers = [];
let billItems = [];
let currentSelectedCustomer = null;
let allBillsCache = []; // To easily fetch past bills for viewing

// --- LOCAL STORAGE NATIVE ARCHITECTURE ---
function getLocal(key) { return JSON.parse(localStorage.getItem(key) || 'null'); }
function setLocal(key, val) { 
    localStorage.setItem(key, JSON.stringify(val)); 
    localStorage.setItem('billbox_last_updated', Date.now());
    if (typeof triggerAutoSync === 'function') triggerAutoSync();
}

async function apiRequest(endpoint, method = 'GET', body = null) {
    // Pure local-first architecture
    return localMockApi(endpoint, method, body);
}

function localMockApi(endpoint, method, body) {
    return new Promise((resolve, reject) => {
        if (endpoint === '/profile') {
            if (method === 'GET') resolve(getLocal('billbox_profile'));
            else if (method === 'POST') {
                setLocal('billbox_profile', body);
                resolve({ message: 'Profile saved locally' });
            }
        } else if (endpoint === '/customers') {
            let customers = getLocal('billbox_customers') || [];
            if (method === 'GET') resolve(customers);
            else if (method === 'POST') {
                const newCust = { ...body, id: Date.now(), previousDue: parseFloat(body.previousDue) || 0 };
                customers.push(newCust);
                setLocal('billbox_customers', customers);

                if (newCust.previousDue > 0) {
                    let bills = getLocal('billbox_bills') || [];
                    const newBill = {
                        id: bills.length + 1,
                        customerId: newCust.id,
                        billDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                        subTotal: newCust.previousDue,
                        discount: 0,
                        tax: 0,
                        previousDue: 0,
                        grandTotal: newCust.previousDue,
                        receivedAmount: 0,
                        newDueAmount: newCust.previousDue,
                        items: [{ name: 'Previous Balance', qty: 1, rate: newCust.previousDue, amount: newCust.previousDue }]
                    };
                    bills.push(newBill);
                    setLocal('billbox_bills', bills);
                }
                resolve({ message: 'Customer added', ...newCust });
            }
        } else if (endpoint === '/bills') {
            let bills = getLocal('billbox_bills') || [];
            if (method === 'GET') {
                let customers = getLocal('billbox_customers') || [];
                let joinedBills = bills.map(b => {
                    let c = customers.find(x => x.id == b.customerId);
                    return { ...b, customerName: c ? c.name : 'Unknown' };
                }).reverse();
                resolve(joinedBills);
            } else if (method === 'POST') {
                const newBill = { ...body, id: bills.length + 1 };
                bills.push(newBill);
                setLocal('billbox_bills', bills);

                let customers = getLocal('billbox_customers') || [];
                let cIndex = customers.findIndex(c => c.id == body.customerId);
                if (cIndex !== -1) {
                    customers[cIndex].previousDue = body.newDueAmount;
                    setLocal('billbox_customers', customers);
                }
                resolve({ message: 'Bill created', billId: newBill.id });
            }
        } else if (endpoint === '/dashboard') {
            let bills = getLocal('billbox_bills') || [];
            let customers = getLocal('billbox_customers') || [];

            let totalBilled = bills.reduce((sum, b) => sum + (parseFloat(b.grandTotal) - parseFloat(b.previousDue)), 0);

            customers.forEach(cust => {
                let custBills = bills.filter(b => b.customerId == cust.id);
                if (custBills.length > 0) {
                    totalBilled += parseFloat(custBills[0].previousDue) || 0;
                } else {
                    totalBilled += parseFloat(cust.previousDue) || 0;
                }
            });

            let totalReceived = bills.reduce((sum, b) => sum + parseFloat(b.receivedAmount || 0), 0);
            let totalDue = customers.reduce((sum, c) => sum + (parseFloat(c.previousDue) || 0), 0);

            resolve({ totalBilled, totalReceived, totalDue });
        } else {
            reject({ error: 'Endpoint not found' });
        }
    });
}
// --- END LOCAL STORAGE NATIVE ARCHITECTURE ---

document.addEventListener('DOMContentLoaded', () => {
    checkProfile();
    setupEventListeners();
    
    // Start interval logic regardless of GDrive connection
    loadBackupInterval();
    if (autoBackupIntervalId) clearInterval(autoBackupIntervalId);
    autoBackupIntervalId = setInterval(checkBackupInterval, 60000);
});

function setupEventListeners() {
    // Setup Form
    document.getElementById('setup-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const brandName = document.getElementById('setup-brandName').value;
        const address = document.getElementById('setup-address').value;
        const phone = document.getElementById('setup-phone').value;
        const email = document.getElementById('setup-email').value;
        const signatureFile = document.getElementById('setup-signature').files[0];

        const btn = e.target.querySelector('button');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;

        try {
            let signatureBase64 = null;
            if (signatureFile) {
                signatureBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (ev) => resolve(ev.target.result);
                    reader.onerror = (err) => reject(err);
                    reader.readAsDataURL(signatureFile);
                });
            }

            if (!signatureBase64 && currentProfile && currentProfile.signature) {
                signatureBase64 = currentProfile.signature;
            }

            const data = { brandName, address, phone, email, signature: signatureBase64 };
            await apiRequest('/profile', 'POST', data);
            checkProfile();
        } catch (error) {
            console.error(error);
            alert('Failed to save profile.');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    // Add Customer Form
    document.getElementById('add-customer-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            name: document.getElementById('cust-name').value,
            phone: document.getElementById('cust-phone').value,
            address: document.getElementById('cust-address').value,
            previousDue: parseFloat(document.getElementById('cust-prevdue').value) || 0
        };
        try {
            const res = await apiRequest('/customers', 'POST', data);
            if (!res.error) {
                closeAddCustomerModal();
                if (document.getElementById('view-customers').style.display !== 'none') {
                    loadCustomers();
                } else if (document.getElementById('view-createBill').style.display !== 'none') {
                    loadCustomerSelect();
                }
            } else {
                alert(res.error || 'Failed to add customer');
            }
        } catch (error) {
            console.error(error);
        }
    });

    // Customer Selection Change for Bill
    document.getElementById('bill-customer-select').addEventListener('change', (e) => {
        const custId = e.target.value;
        if (custId) {
            currentSelectedCustomer = currentCustomers.find(c => c.id == custId);
            document.getElementById('bc-name').innerText = currentSelectedCustomer.name;
            document.getElementById('bc-phone').innerText = currentSelectedCustomer.phone;
            document.getElementById('bc-prevDue').innerText = parseFloat(currentSelectedCustomer.previousDue).toFixed(2);
            document.getElementById('bill-display-prevDue').innerText = parseFloat(currentSelectedCustomer.previousDue).toFixed(2);
            document.getElementById('bill-customer-details').style.display = 'block';
            calculateTotals();
        } else {
            currentSelectedCustomer = null;
            document.getElementById('bill-customer-details').style.display = 'none';
            document.getElementById('bill-display-prevDue').innerText = '0.00';
            calculateTotals();
        }
    });
}

// Navigation
function navigateTo(viewId, tabBtn = null) {
    // Clear cached PDF when leaving bill preview
    if (viewId !== 'billPreview') {
        preGeneratedPdfBlob = null;
    }

    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById('view-' + viewId).style.display = 'block';

    if (tabBtn) {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        tabBtn.classList.add('active');
    }

    if (viewId === 'dashboard') loadDashboard();
    if (viewId === 'customers') loadCustomers();
    if (viewId === 'createBill') {
        billItems = []; // reset items
        renderBillItems();
        loadCustomerSelect();
    }
}

// Profile
async function checkProfile() {
    try {
        const profile = await apiRequest('/profile');
        if (profile && profile.brandName) {
            currentProfile = profile;

            // Pre-fill form for editing
            document.getElementById('setup-brandName').value = profile.brandName || '';
            document.getElementById('setup-address').value = profile.address || '';
            document.getElementById('setup-phone').value = profile.phone || '';
            document.getElementById('setup-email').value = profile.email || '';

            document.getElementById('navbar').style.display = 'flex';
            if (window.innerWidth <= 768) document.getElementById('mobile-tab-bar').style.display = 'flex';
            document.getElementById('dash-brand-name').innerText = profile.brandName;

            // Only navigate to dashboard if we are coming from save or initial load
            if (document.getElementById('view-setup').style.display !== 'none' || document.querySelectorAll('.view[style="display: block;"]').length === 0) {
                navigateTo('dashboard');
            }
        } else {
            document.getElementById('navbar').style.display = 'none';
            document.getElementById('mobile-tab-bar').style.display = 'none';
            navigateTo('setup');
        }
    } catch (error) {
        console.error("Failed to check profile", error);
        navigateTo('setup');
    }
}

// Dashboard
async function loadDashboard() {
    try {
        const stats = await apiRequest('/dashboard');
        document.getElementById('stat-due').innerText = `₹${parseFloat(stats.totalDue).toFixed(2)}`;
        document.getElementById('stat-received').innerText = `₹${parseFloat(stats.totalReceived).toFixed(2)}`;
        document.getElementById('stat-billed').innerText = `₹${parseFloat(stats.totalBilled).toFixed(2)}`;

        const bills = await apiRequest('/bills');
        const container = document.getElementById('recent-bills-list');
        container.innerHTML = '';
        if (bills.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:32px 16px;color:var(--text-3);"><i class="fa-solid fa-file-invoice" style="font-size:2rem;margin-bottom:12px;display:block;"></i><p style="font-size:0.9rem;">No bills yet.<br>Tap <strong>New Bill</strong> to create one!</p></div>`;
            return;
        }
        bills.slice(0, 15).forEach((bill, index) => {
            const isPaid = bill.newDueAmount <= 0;
            const badge = isPaid
                ? `<span class="bill-row-badge badge-paid"><i class="fa-solid fa-check"></i> Paid</span>`
                : `<span class="bill-row-badge badge-due">Due ₹${parseFloat(bill.newDueAmount).toFixed(0)}</span>`;
            const delayClass = `delay-${(index % 5) + 1}`;
            container.innerHTML += `
                <div class="bill-row-card animate-item ${delayClass}" onclick="viewCustomer(${bill.customerId})">
                    <div class="bill-row-icon"><i class="fa-solid fa-file-invoice"></i></div>
                    <div class="bill-row-info">
                        <div class="bill-row-name">${bill.customerName}</div>
                        <div class="bill-row-meta">#${bill.id} &bull; ${bill.billDate}</div>
                    </div>
                    <div class="bill-row-right">
                        <div class="bill-row-amount">₹${parseFloat(bill.grandTotal).toFixed(0)}</div>
                        ${badge}
                    </div>
                </div>
            `;
        });
    } catch (error) {
        console.error("Failed to load dashboard data", error);
    }
}

// Customers
function renderCustomerCards(customers, container) {
    container.innerHTML = '';
    if (customers.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:32px 16px;color:var(--text-3);"><i class="fa-solid fa-users" style="font-size:2rem;margin-bottom:12px;display:block;"></i><p style="font-size:0.9rem;">No customers found.</p></div>`;
        return;
    }
    customers.forEach((cust, index) => {
        const due = parseFloat(cust.previousDue);
        const initials = cust.name ? cust.name.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase() : '?';
        const dueColor = due > 0 ? 'var(--danger)' : 'var(--success)';
        const dueLabel = due > 0 ? `₹${due.toFixed(0)} Due` : 'Cleared';
        const delayClass = `delay-${(index % 5) + 1}`;
        container.innerHTML += `
            <div class="customer-card animate-item ${delayClass}" onclick="viewCustomer(${cust.id})">
                <div class="customer-avatar">${initials}</div>
                <div class="customer-info">
                    <div class="customer-name">${cust.name}</div>
                    <div class="customer-phone"><i class="fa-solid fa-phone" style="font-size:0.7rem;"></i> ${cust.phone}</div>
                </div>
                <div class="customer-due">
                    <div class="customer-due-amount" style="color:${dueColor};">${dueLabel}</div>
                    <div class="customer-due-label">Balance</div>
                </div>
            </div>
        `;
    });
}

async function loadCustomers() {
    try {
        currentCustomers = await apiRequest('/customers');
        const container = document.getElementById('customers-list');
        renderCustomerCards(currentCustomers, container);
    } catch (error) {
        console.error(error);
    }
}

function searchCustomers() {
    const term = document.getElementById('search-customers-input').value.toLowerCase();
    const container = document.getElementById('customers-list');
    const filtered = (currentCustomers || []).filter(c =>
        (c.name && c.name.toLowerCase().includes(term)) ||
        (c.phone && c.phone.includes(term))
    );
    renderCustomerCards(filtered, container);
}

async function loadCustomerSelect() {
    try {
        currentCustomers = await apiRequest('/customers');
        const select = document.getElementById('bill-customer-select');
        const currentVal = select.value;
        select.innerHTML = '<option value="">-- Select Customer --</option>';
        currentCustomers.forEach(cust => {
            select.innerHTML += `<option value="${cust.id}">${cust.name} - ${cust.phone}</option>`;
        });
        select.value = currentVal;
    } catch (error) {
        console.error(error);
    }
}

// Customer Dashboard
async function viewCustomer(customerId) {
    try {
        currentCustomers = await apiRequest('/customers');
        const cust = currentCustomers.find(c => c.id == customerId);
        if (!cust) return;

        document.getElementById('cd-name').innerText = cust.name;
        document.getElementById('cd-phone').innerText = cust.phone;
        document.getElementById('cd-stat-due').innerText = `₹${parseFloat(cust.previousDue).toFixed(2)}`;

        allBillsCache = await apiRequest('/bills');
        const custBills = allBillsCache.filter(b => b.customerId == customerId);

        let initialDue = 0;
        if (custBills.length > 0) {
            // Since bills are fetched in DESC order, the oldest bill is at the end
            initialDue = parseFloat(custBills[custBills.length - 1].previousDue) || 0;
        } else {
            initialDue = parseFloat(cust.previousDue) || 0;
        }

        let totalBilled = custBills.reduce((sum, b) => sum + (parseFloat(b.grandTotal) - parseFloat(b.previousDue)), 0);
        totalBilled += initialDue;

        let totalReceived = custBills.reduce((sum, b) => sum + parseFloat(b.receivedAmount || 0), 0);

        document.getElementById('cd-stat-billed').innerText = `₹${totalBilled.toFixed(2)}`;
        document.getElementById('cd-stat-received').innerText = `₹${totalReceived.toFixed(2)}`;

        const tbody = document.getElementById('cd-bills-list');
        tbody.innerHTML = '';
        custBills.forEach((bill, index) => {
            const status = bill.newDueAmount <= 0 ? '<span style="color:var(--success)">Paid</span>' : `<span style="color:var(--danger)">Due(₹${parseFloat(bill.newDueAmount).toFixed(2)})</span>`;
            const delayClass = `delay-${(index % 5) + 1}`;
            tbody.innerHTML += `
                <tr class="animate-item ${delayClass}">
                    <td>#${bill.id}</td>
                    <td>${bill.billDate}</td>
                    <td>₹${parseFloat(bill.grandTotal).toFixed(2)}</td>
                    <td>₹${parseFloat(bill.receivedAmount || 0).toFixed(2)}</td>
                    <td>${status}</td>
                    <td><button onclick="viewPastBill(${bill.id}, ${cust.id})" class="btn-secondary" style="padding: 6px 12px; font-size: 0.85rem;">View</button></td>
                </tr>
            `;
        });

        navigateTo('customerDashboard');
    } catch (err) {
        console.error(err);
    }
}

function viewPastBill(billId, customerId) {
    const bill = allBillsCache.find(b => b.id == billId);
    const cust = currentCustomers.find(c => c.id == customerId);
    if (!bill || !cust) return;

    let items = bill.items;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { items = []; }
    }

    renderPrintPreview({
        billNo: bill.id,
        customer: cust,
        billDate: bill.billDate,
        items: items,
        subTotal: bill.subTotal,
        discount: bill.discount,
        tax: bill.tax,
        previousDue: bill.previousDue,
        grandTotal: bill.grandTotal,
        receivedAmount: bill.receivedAmount,
        newDueAmount: bill.newDueAmount
    });
    navigateTo('billPreview');
}

// Bill Logic
function addBillItem() {
    const name = document.getElementById('item-name').value;
    const qty = parseFloat(document.getElementById('item-qty').value);
    const rate = parseFloat(document.getElementById('item-rate').value);

    if (!name || !qty || !rate) return alert('Please enter item details correctly.');

    billItems.push({ name, qty, rate, amount: qty * rate });

    // reset inputs
    document.getElementById('item-name').value = '';
    document.getElementById('item-qty').value = '';
    document.getElementById('item-rate').value = '';

    renderBillItems();
}

function removeBillItem(index) {
    billItems.splice(index, 1);
    renderBillItems();
}

function renderBillItems() {
    const tbody = document.getElementById('bill-items-list');
    tbody.innerHTML = '';
    billItems.forEach((item, index) => {
        const delayClass = `delay-1`;
        tbody.innerHTML += `
            <tr class="animate-item ${delayClass}">
                <td>${index + 1}</td>
                <td>${item.name}</td>
                <td>${item.qty}</td>
                <td>₹${item.rate.toFixed(2)}</td>
                <td>₹${item.amount.toFixed(2)}</td>
                <td><button onclick="removeBillItem(${index})" style="color:var(--danger); background:none; border:none; cursor:pointer;"><i class="fa-solid fa-trash"></i></button></td>
            </tr>
        `;
    });
    calculateTotals();
}

function calculateTotals() {
    let subTotal = billItems.reduce((sum, item) => sum + item.amount, 0);
    document.getElementById('bill-subtotal').innerText = subTotal.toFixed(2);

    let discount = parseFloat(document.getElementById('bill-discount').value) || 0;
    let taxPercent = parseFloat(document.getElementById('bill-tax').value) || 0;

    let taxAmount = (subTotal - discount) * (taxPercent / 100);
    if (taxAmount < 0) taxAmount = 0;

    let previousDue = currentSelectedCustomer ? parseFloat(currentSelectedCustomer.previousDue) : 0;

    let grandTotal = subTotal - discount + taxAmount + previousDue;
    document.getElementById('bill-grandTotal').innerText = grandTotal.toFixed(2);

    let received = parseFloat(document.getElementById('bill-received').value) || 0;
    let newDue = grandTotal - received;
    document.getElementById('bill-newDue').innerText = newDue.toFixed(2);
}

async function saveBill() {
    if (!currentSelectedCustomer) return alert('Please select a customer.');

    let received = parseFloat(document.getElementById('bill-received').value) || 0;
    if (billItems.length === 0 && received <= 0 && parseFloat(currentSelectedCustomer.previousDue) <= 0) {
        return alert('Please add items or enter a received amount to record a payment.');
    }

    calculateTotals();

    const data = {
        customerId: currentSelectedCustomer.id,
        billDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        subTotal: parseFloat(document.getElementById('bill-subtotal').innerText),
        discount: parseFloat(document.getElementById('bill-discount').value) || 0,
        tax: parseFloat(document.getElementById('bill-tax').value) || 0,
        previousDue: parseFloat(currentSelectedCustomer.previousDue),
        grandTotal: parseFloat(document.getElementById('bill-grandTotal').innerText),
        receivedAmount: parseFloat(document.getElementById('bill-received').value) || 0,
        newDueAmount: parseFloat(document.getElementById('bill-newDue').innerText),
        items: billItems
    };

    try {
        const result = await apiRequest('/bills', 'POST', data);
        if (!result.error) {
            renderPrintPreview({
                billNo: result.billId,
                customer: currentSelectedCustomer,
                ...data
            });
            navigateTo('billPreview');
        } else {
            alert(result.error || 'Failed to save bill');
        }
    } catch (error) {
        console.error(error);
        alert('Error saving bill');
    }
}

// Print & Share
function renderPrintPreview(billData) {
    document.getElementById('print-brand-name').innerText = currentProfile.brandName;
    document.getElementById('print-brand-address').innerText = currentProfile.address;
    document.getElementById('print-brand-contact').innerText = `Phone: ${currentProfile.phone} | Email: ${currentProfile.email}`;

    document.getElementById('print-cust-name').innerText = billData.customer.name;
    document.getElementById('print-cust-phone').innerText = billData.customer.phone;
    document.getElementById('print-cust-address').innerText = billData.customer.address || '-';

    document.getElementById('print-bill-no').innerText = billData.billNo;
    document.getElementById('print-bill-date').innerText = billData.billDate;

    const tbody = document.getElementById('print-items-body');
    tbody.innerHTML = '';

    let totalQty = 0;
    let indexCount = 0;

    if (billData.items && billData.items.length > 0) {
        billData.items.forEach((item, index) => {
            indexCount++;
            totalQty += item.qty;
            tbody.innerHTML += `
                <tr>
                    <td>${indexCount}.</td>
                    <td>${item.name}</td>
                    <td>${item.qty}</td>
                    <td>${item.rate}</td>
                    <td>₹${item.amount.toFixed(2)}</td>
                </tr>
            `;
        });
    }

    if (billData.previousDue > 0) {
        indexCount++;
        tbody.innerHTML += `
            <tr>
                <td>${indexCount}.</td>
                <td>Old Balance</td>
                <td>1</td>
                <td>${billData.previousDue.toFixed(2)}</td>
                <td>₹${billData.previousDue.toFixed(2)}</td>
            </tr>
        `;
        totalQty += 1;
    }

    // If absolutely no items and no previous due, add a placeholder for payment
    if (indexCount === 0) {
        tbody.innerHTML += `
            <tr>
                <td>1.</td>
                <td>Payment Received</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
            </tr>
        `;
    }

    // Append Calculation Rows directly into the table
    if (billData.discount > 0) {
        tbody.innerHTML += `
            <tr class="print-calc-row">
                <td colspan="4">Discount:</td>
                <td>-₹${billData.discount.toFixed(2)}</td>
            </tr>
        `;
    }
    if (billData.tax > 0) {
        tbody.innerHTML += `
            <tr class="print-calc-row">
                <td colspan="4">Tax:</td>
                <td>+₹${billData.tax.toFixed(2)}</td>
            </tr>
        `;
    }

    tbody.innerHTML += `
        <tr class="print-calc-row">
            <td colspan="4">Total:</td>
            <td>₹${billData.grandTotal.toFixed(2)}</td>
        </tr>
    `;

    if (billData.receivedAmount > 0) {
        tbody.innerHTML += `
            <tr class="print-calc-row">
                <td colspan="4">Received:</td>
                <td>₹${billData.receivedAmount.toFixed(2)}</td>
            </tr>
        `;
    }

    tbody.innerHTML += `
        <tr class="print-calc-row-due">
            <td colspan="4">Due:</td>
            <td>₹${billData.newDueAmount.toFixed(2)}</td>
        </tr>
    `;

    // In Words row
    const words = numberToWords(Math.round(billData.grandTotal)) + ' Only';
    tbody.innerHTML += `
        <tr class="in-words-row">
            <td colspan="5"><strong>In Word:</strong> ${words}</td>
        </tr>
    `;

    const sigImg = document.getElementById('print-signature-img');
    if (currentProfile && currentProfile.signature) {
        sigImg.src = currentProfile.signature;
        sigImg.style.display = 'block';
    } else {
        sigImg.src = '';
        sigImg.style.display = 'none';
    }
}

function printBill() {
    const element = document.getElementById('printable-bill');
    const filename = `Bill_${document.getElementById('print-bill-no').innerText}.pdf`;
    const opt = getPdfOptions(filename);
    html2pdf().set(opt).from(element).save();
}

// PDF Options - shared across print and share to guarantee same layout
function getPdfOptions(filename) {
    return {
        margin: 0.2,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, windowWidth: 800 },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
}

// Reliably download the PDF (works on laptop AND mobile)
async function shareBill() {
    const shareBtn = document.querySelector('button[onclick="shareBill()"]');
    const originalText = shareBtn ? shareBtn.innerHTML : '';
    const filename = `Bill_${document.getElementById('print-bill-no').innerText}.pdf`;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (shareBtn) { shareBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing...'; shareBtn.disabled = true; }

    try {
        const element = document.getElementById('printable-bill');
        const opt = getPdfOptions(filename);
        const blob = await html2pdf().set(opt).from(element).outputPdf('blob');

        const file = new File([blob], filename, { type: 'application/pdf' });

        // Re-enable button before any share/download action
        if (shareBtn) { shareBtn.innerHTML = originalText; shareBtn.disabled = false; }

        // On mobile: try native share API first (shows WhatsApp, Telegram, etc)
        if (isMobile && navigator.share) {
            let shared = false;
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try { await navigator.share({ title: 'Bill Invoice', files: [file] }); shared = true; }
                catch(e) { if (e.name === 'AbortError') return; }
            }
            if (!shared) {
                try { await navigator.share({ title: 'Bill Invoice', files: [file] }); shared = true; }
                catch(e) { if (e.name === 'AbortError') return; }
            }
            if (shared) return; // Success via share API
        }

        // GUARANTEED: Direct download — works on ALL devices (laptop, mobile, tablet)
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        if (isMobile) {
            showToast('✅ PDF saved! Open your Downloads folder to share via WhatsApp.');
        } else {
            showToast('✅ PDF downloaded! Check your Downloads folder.');
        }

    } catch(err) {
        console.error('Share/Download error:', err);
        if (shareBtn) { shareBtn.innerHTML = originalText; shareBtn.disabled = false; }
        showToast('❌ Error preparing PDF. Please try the PDF button instead.');
    }
}

// Share directly to WhatsApp (downloads PDF first, then opens WhatsApp)
async function shareToWhatsApp() {
    const waBtn = document.querySelector('button[onclick="shareToWhatsApp()"]');
    const originalText = waBtn ? waBtn.innerHTML : '';
    const filename = `Bill_${document.getElementById('print-bill-no').innerText}.pdf`;

    if (waBtn) { waBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing...'; waBtn.disabled = true; }

    try {
        const element = document.getElementById('printable-bill');
        const opt = getPdfOptions(filename);
        const blob = await html2pdf().set(opt).from(element).outputPdf('blob');

        const file = new File([blob], filename, { type: 'application/pdf' });

        if (waBtn) { waBtn.innerHTML = originalText; waBtn.disabled = false; }

        // Try to share the file directly (works on many Android devices)
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ title: 'Bill Invoice', files: [file] });
                return;
            } catch(e) {
                if (e.name === 'AbortError') return;
            }
        }

        // Fallback: download PDF + open WhatsApp
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        // Open WhatsApp after short delay (let download start)
        setTimeout(() => {
            window.open('https://wa.me/?text=' + encodeURIComponent(`Please find attached the bill PDF (${filename}) saved in your Downloads folder.`), '_blank');
        }, 1000);

    } catch(err) {
        console.error('WhatsApp share error:', err);
        if (waBtn) { waBtn.innerHTML = originalText; waBtn.disabled = false; }
        showToast('❌ Error. Please try again.');
    }
}

// Show a toast notification
function showToast(message) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.95);color:white;padding:14px 24px;border-radius:50px;font-size:0.9rem;font-weight:600;z-index:9999;max-width:90vw;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.3);backdrop-filter:blur(10px);transition:opacity 0.3s ease;';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 4000);
}


// Modals
function showAddCustomerModal() { document.getElementById('addCustomerModal').classList.add('show'); }
function closeAddCustomerModal() { document.getElementById('addCustomerModal').classList.remove('show'); }

// Number to Words Converter
function numberToWords(num) {
    var a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    var b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    if ((num = num.toString()).length > 9) return 'Overflow';
    let n = ('000000000' + num).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return ''; var str = '';
    str += (n[1] != 0) ? (a[Number(n[1])] || b[n[1][0]] + ' ' + a[n[1][1]]) + 'Crore ' : '';
    str += (n[2] != 0) ? (a[Number(n[2])] || b[n[2][0]] + ' ' + a[n[2][1]]) + 'Lakh ' : '';
    str += (n[3] != 0) ? (a[Number(n[3])] || b[n[3][0]] + ' ' + a[n[3][1]]) + 'Thousand ' : '';
    str += (n[4] != 0) ? (a[Number(n[4])] || b[n[4][0]] + ' ' + a[n[4][1]]) + 'Hundred ' : '';
    str += (n[5] != 0) ? ((str != '') ? 'and ' : '') + (a[Number(n[5])] || b[n[5][0]] + ' ' + a[n[5][1]]) : '';
    return str.trim() || 'Zero';
}

// Backup & Restore functionality
function exportBackup() {
    const data = {
        profile: getLocal('billbox_profile'),
        customers: getLocal('billbox_customers'),
        bills: getLocal('billbox_bills')
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);

    const date = new Date().toISOString().split('T')[0];
    downloadAnchorNode.setAttribute("download", "BillBox_Backup_" + date + ".json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function importBackup(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.profile !== undefined && data.customers !== undefined && data.bills !== undefined) {
                if (confirm('Are you sure you want to overwrite all current data with this backup?')) {
                    setLocal('billbox_profile', data.profile);
                    setLocal('billbox_customers', data.customers);
                    setLocal('billbox_bills', data.bills);
                    alert('Data restored successfully! The app will now reload.');
                    window.location.reload();
                }
            } else {
                alert('Invalid backup file format.');
            }
        } catch (error) {
            alert('Error reading backup file.');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// --- GOOGLE DRIVE SYNC INTEGRATION (FRONTEND FOR NETLIFY) ---

// TODO: Replace with your actual Google Client ID from Google Cloud Console
const CLIENT_ID = '545587129402-a7vttlks09rucnbtq80o4d24a5dnm56k.apps.googleusercontent.com';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let gdriveFileName = 'BillBox_CloudBackup.json';
let fileId = null;
let autoBackupIntervalId = null;

function gapiLoaded() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    try {
        await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
        checkAuthReady();
    } catch (e) {
        console.error("GAPI Init Error", e);
    }
}

function gisLoaded() {
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: '', // defined later
        });
        gisInited = true;
        checkAuthReady();
    } catch (e) {
        console.error("GIS Init Error", e);
    }
}

function checkAuthReady() {
    if (gapiInited && gisInited) {
        if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
            document.getElementById('gdrive-status').innerText = 'Missing Google Client ID. Update CLIENT_ID in app.js.';
            document.getElementById('gdrive-status').style.color = 'var(--danger)';
        } else {
            document.getElementById('gdrive-status').innerText = 'Ready to connect to Google Drive.';
            
            // If we are already signed in from a previous session, restore state
            const token = localStorage.getItem('gdrive_token');
            if (token && token !== 'null') {
                gapi.client.setToken(JSON.parse(token));
                document.getElementById('gdrive-auth-container').style.display = 'none';
                document.getElementById('gdrive-actions-container').style.display = 'flex';
                document.getElementById('gdrive-status').innerText = 'Connected to Google Drive.';
                
                findExistingBackupAndSync();
            }
        }
    }
}

function handleAuthClick() {
    if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
        alert("Please replace 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' in app.js with a valid Google Cloud Client ID.");
        return;
    }

    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) {
            throw (resp);
        }
        gapi.client.setToken(resp);
        localStorage.setItem('gdrive_token', JSON.stringify(resp));
        document.getElementById('gdrive-auth-container').style.display = 'none';
        document.getElementById('gdrive-actions-container').style.display = 'flex';
        document.getElementById('gdrive-status').innerText = 'Connected to Google Drive.';
        
        await findExistingBackupAndSync();
    };

    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

function handleSignoutClick() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
        localStorage.removeItem('gdrive_token');
        document.getElementById('gdrive-auth-container').style.display = 'block';
        document.getElementById('gdrive-actions-container').style.display = 'none';
        document.getElementById('gdrive-status').innerText = 'Disconnected.';
        fileId = null;
    }
}

// Backup Interval Logic
function saveBackupInterval() {
    const hours = document.getElementById('backup-interval-select').value;
    localStorage.setItem('backup_interval_hours', hours);
    document.getElementById('gdrive-status').innerText = `Auto-backup interval set to ${hours} hours.`;
}

function loadBackupInterval() {
    const hours = localStorage.getItem('backup_interval_hours') || '12';
    document.getElementById('backup-interval-select').value = hours;
}

async function checkBackupInterval() {
    const hours = parseInt(localStorage.getItem('backup_interval_hours') || '12');
    const lastBackup = parseInt(localStorage.getItem('last_backup_timestamp') || '0');
    const now = Date.now();
    
    // Check if (hours) have passed since last backup
    if (now - lastBackup > (hours * 60 * 60 * 1000)) {
        console.log(`[Auto-Backup] ${hours} hours have passed. Triggering background backup.`);
        
        localStorage.setItem('last_backup_timestamp', now.toString());

        // 1. GDrive Backup
        if (typeof gapi !== 'undefined' && gapi.client && gapi.client.getToken()) {
            await backupToGDrive(true); // silent backup
        }
        
        // 2. Prompt for Local Backup
        showLocalBackupPrompt();
    }
}

function showLocalBackupPrompt() {
    let toast = document.getElementById('local-backup-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'local-backup-toast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(15,23,42,0.95);color:white;padding:15px 25px;border-radius:12px;font-size:0.95rem;font-weight:500;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,0.3);backdrop-filter:blur(10px);display:flex;flex-direction:column;gap:10px; border-left: 4px solid var(--primary);';
        
        toast.innerHTML = `
            <div><strong>Auto-Backup Time!</strong><br><span style="font-size:0.85rem;color:#cbd5e1;">It is time for your scheduled local backup.</span></div>
            <div style="display:flex;gap:10px;">
                <button onclick="executeScheduledLocalBackup()" style="background:var(--primary);color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-weight:bold;"><i class="fa-solid fa-download"></i> Download</button>
                <button onclick="dismissLocalBackupPrompt()" style="background:transparent;color:#94a3b8;border:1px solid #475569;padding:8px 12px;border-radius:6px;cursor:pointer;">Dismiss</button>
            </div>
        `;
        document.body.appendChild(toast);
    }
    toast.style.display = 'flex';
}

window.executeScheduledLocalBackup = function() {
    exportBackup();
    dismissLocalBackupPrompt();
};

window.dismissLocalBackupPrompt = function() {
    const toast = document.getElementById('local-backup-toast');
    if (toast) toast.style.display = 'none';
};

async function backupNowCombined() {
    document.getElementById('gdrive-status').innerText = 'Running manual backup (Drive & Local)...';
    await backupToGDrive(false);
    exportBackup();
}

let syncTimeout = null;
function triggerAutoSync() {
    if (!gapiInited || !gisInited || !gapi.client || !gapi.client.getToken()) return;
    
    // Original behavior: Debounce background sync when data changes
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        backupToGDrive(true); 
    }, 3000);
}

async function findExistingBackupAndSync() {
    try {
        const response = await gapi.client.drive.files.list({
            q: `name='${gdriveFileName}' and trashed=false`,
            fields: 'files(id, name, modifiedTime)',
            spaces: 'drive'
        });
        const files = response.result.files;
        if (files && files.length > 0) {
            fileId = files[0].id; // We found the existing file to OVERWRITE
            const modified = new Date(files[0].modifiedTime).toLocaleString();
            document.getElementById('gdrive-status').innerText = `Checking cloud backup...`;
            await autoSyncCompare(fileId);
        } else {
            fileId = null;
            document.getElementById('gdrive-status').innerText = 'No cloud data found. Pushing local data...';
            await backupToGDrive(true);
        }
    } catch (err) {
        console.error('Error finding backup', err);
        if (err && err.status === 401) {
            document.getElementById('gdrive-status').innerText = 'Session expired. Please reconnect.';
            handleSignoutClick();
        } else {
            document.getElementById('gdrive-status').innerText = 'Error checking for backups.';
        }
    }
}

async function autoSyncCompare(cloudFileId) {
    try {
        const response = await gapi.client.drive.files.get({
            fileId: cloudFileId,
            alt: 'media'
        });

        const cloudData = response.result;
        const cloudTime = cloudData.timestamp || 0;
        const localTime = parseInt(localStorage.getItem('billbox_last_updated') || '0');

        if (cloudTime > localTime) {
            if (cloudData.profile !== undefined) localStorage.setItem('billbox_profile', JSON.stringify(cloudData.profile));
            if (cloudData.customers !== undefined) localStorage.setItem('billbox_customers', JSON.stringify(cloudData.customers));
            if (cloudData.bills !== undefined) localStorage.setItem('billbox_bills', JSON.stringify(cloudData.bills));
            localStorage.setItem('billbox_last_updated', cloudTime);
            
            document.getElementById('gdrive-status').innerText = 'Synced with cloud! Reloading UI...';
            setTimeout(() => window.location.reload(), 1500);
        } else if (localTime > cloudTime) {
            document.getElementById('gdrive-status').innerText = 'Pushing local changes to cloud...';
            await backupToGDrive(true);
            document.getElementById('gdrive-status').innerText = 'Sync complete.';
        } else {
            document.getElementById('gdrive-status').innerText = 'Cloud sync is up to date.';
            checkBackupInterval(); // Check if we still need a scheduled backup
        }
    } catch (err) {
        console.error('Auto sync error', err);
        document.getElementById('gdrive-status').innerText = 'Failed to sync with cloud.';
    }
}

async function backupToGDrive(silent = false) {
    if (!gapi.client || !gapi.client.getToken()) {
        if(!silent) alert('Please connect to Google Drive first.');
        return;
    }

    if(!silent) document.getElementById('gdrive-status').innerText = 'Uploading backup to Google Drive...';

    const data = {
        profile: getLocal('billbox_profile'),
        customers: getLocal('billbox_customers'),
        bills: getLocal('billbox_bills'),
        timestamp: parseInt(localStorage.getItem('billbox_last_updated') || Date.now().toString())
    };

    const fileContent = JSON.stringify(data);
    const metadata = {
        'name': gdriveFileName,
        'mimeType': 'application/json'
    };

    try {
        const accessToken = gapi.client.getToken().access_token;
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([fileContent], { type: 'application/json' }));

        let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
        let method = 'POST';

        if (fileId) {
            // Overwrite existing file instead of creating a new one
            url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`;
            method = 'PATCH';
        }

        const response = await fetch(url, {
            method: method,
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
            body: form
        });

        const result = await response.json();
        if (result.id) {
            fileId = result.id;
            localStorage.setItem('last_backup_timestamp', Date.now().toString());
            const timeStr = new Date().toLocaleTimeString();
            if(!silent) document.getElementById('gdrive-status').innerText = 'Backup successful! ' + timeStr;
            else document.getElementById('gdrive-status').innerText = 'Auto-synced at ' + timeStr;
        } else {
            throw new Error('Upload failed');
        }
    } catch (err) {
        console.error('Backup error', err);
        if (err && err.status === 401) {
            if(!silent) document.getElementById('gdrive-status').innerText = 'Session expired. Please reconnect.';
            handleSignoutClick();
        } else {
            if(!silent) document.getElementById('gdrive-status').innerText = 'Backup failed.';
            else document.getElementById('gdrive-status').innerText = 'Auto-sync failed.';
        }
    }
}

async function restoreFromGDrive() {
    if (!gapi.client.getToken()) return alert('Please connect to Google Drive first.');
    if (!fileId) return alert('No backup found on Google Drive. You may need to create one first.');

    if (!confirm('Are you sure you want to overwrite your local app data with the cloud backup? This cannot be undone.')) return;

    document.getElementById('gdrive-status').innerText = 'Downloading backup...';

    try {
        const response = await gapi.client.drive.files.get({
            fileId: fileId,
            alt: 'media'
        });

        const data = response.result;
        if (data.profile !== undefined && data.customers !== undefined && data.bills !== undefined) {
            setLocal('billbox_profile', data.profile);
            setLocal('billbox_customers', data.customers);
            setLocal('billbox_bills', data.bills);
            document.getElementById('gdrive-status').innerText = 'Restore successful! Reloading...';
            setTimeout(() => window.location.reload(), 1000);
        } else {
            alert('Invalid backup format on cloud.');
            document.getElementById('gdrive-status').innerText = 'Restore failed: Invalid format.';
        }
    } catch (err) {
        console.error('Restore error', err);
        document.getElementById('gdrive-status').innerText = 'Restore failed.';
    }
}
