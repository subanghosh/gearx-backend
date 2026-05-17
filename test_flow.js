const http = require('http');

async function request(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api' + path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function runTests() {
    console.log("🚀 Starting End-to-End API Test for Dynamic Pricing...");

    try {
        console.log("1. Creating Garage with 20% Commission Rate...");
        const garageId = 'g_test_' + Date.now();
        const gRes = await request('/garages', 'POST', {
            id: garageId, name: "Test Garage", address: "123 Main St", contact: "12345", commissionRate: 20
        });
        console.assert(gRes.status === 200, "Garage creation failed");
        console.log("✅ Garage Created:", gRes.data.id);

        console.log("2. Setting Garage Rate for Inspection (Base $100)...");
        const rateRes = await request(`/garages/${garageId}/rates`, 'POST', {
            vehicleType: "Car", itemCategory: "Safety and Brakes", item: "Brake Pads", logicType: "inspection", price: 100
        });
        console.assert(rateRes.status === 200, "Setting rate failed");
        console.log("✅ Rate Set Successfully");

        console.log("3. Creating Customer and Request...");
        const custRes = await request('/customers', 'POST', {
            id: 'c_test_' + Date.now(), name: "John Doe", phone: "9876543210"
        });
        const customerId = custRes.data.id;

        const reqId = 'r_test_' + Date.now();
        const rRes = await request('/requests', 'POST', {
            id: reqId, customerId: customerId, vehicleId: "v_123", date: "2026-03-05", status: "Pending", issue: "Squeaky brakes", inspectionCategory: "Safety and Brakes"
        });
        console.assert(rRes.status === 200, "Request creation failed");
        console.log("✅ Service Request Created:", rRes.data.id);

        console.log("4. Admin Assigns Garage and Generates Quote...");
        const quoteRes = await request(`/requests/${reqId}/quote`, 'PUT', {
            garageId: garageId, inspectionCategory: "Safety and Brakes", categorySource: "admin"
        });
        if (quoteRes.status !== 200) {
            console.error("Quoting failed with response:", quoteRes);
            return;
        }

        // Expected Base: 100, Commission: 20% = 20, Total Quote: 120
        const expectedQuote = 120;
        if (quoteRes.data.inspectionQuote === expectedQuote) {
            console.log(`✅ Quote successfully calculated: $${quoteRes.data.inspectionQuote}`);
        } else {
            console.error(`❌ Quote mismatch! Expected $${expectedQuote}, got $${quoteRes.data.inspectionQuote}`);
            return;
        }

        console.log("5. Customer Approves Inspection...");
        const appRes = await request(`/requests/${reqId}/approve-inspection`, 'POST');
        console.assert(appRes.status === 200, "Approval failed");
        console.log("✅ Inspection Approved");

        console.log("6. Marshal Dispatches Trip...");
        const tripId = 't_test_' + Date.now();
        const tRes = await request('/trips', 'POST', {
            id: tripId, serviceRequestId: reqId, marshalId: "m_1", status: "at_garage", startOdometer: 1000, otp1: "1234", pickupLat: 0, pickupLng: 0
        });
        console.assert(tRes.status === 200, "Trip creation failed");
        console.log("✅ Trip Successfully Delivered to Garage:", tRes.data.id);

        console.log("7. Mechanic Submits Final Audit (Base $500)...");
        const auditRes = await request(`/trips/${tripId}/audit`, 'POST', {
            id: 'a_test_' + Date.now(), mechanicId: "mech_1", data: { "Brake Pads": "Replace" }, totalEstimate: 500
        });
        console.assert(auditRes.status === 200, "Audit failed: " + JSON.stringify(auditRes));

        // Expected Base: 500, Commission: 20% = 100, Total Estimate: 600
        const expectedEstimate = 600;
        if (auditRes.data.customerEstimate === expectedEstimate) {
            console.log(`✅ Final Customer Estimate correctly calculated: $${auditRes.data.customerEstimate}`);
        } else {
            console.error(`❌ Estimate mismatch! Expected $${expectedEstimate}, got $${auditRes.data.customerEstimate}`);
            return;
        }

        console.log("🎉 All Tests Passed Successfully!");

    } catch (e) {
        console.error("Test execution failed:", e);
    }
}

runTests();
