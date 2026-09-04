const fs = require('fs');

async function runTests() {
    const API_URL = 'http://localhost:3000/api';
    console.log('--- STARTING E2E GARAGE RETURN-ONLY FLOW VALIDATION ---');

    // Create test customer
    const custId = 'test_cust_ret_' + Date.now();
    const custPhoneNum = '+91' + Math.floor(6000000000 + Math.random() * 4000000000);
    const custEmailAddr = 'verify_cust_ret_' + Date.now() + '@redrivo.com';
    const custRes = await fetch(`${API_URL}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: custId,
            name: 'Return Customer',
            phone: custPhoneNum,
            email: custEmailAddr
        })
    });
    if (!custRes.ok) throw new Error('Failed to create customer');
    console.log('Created test customer:', custId);

    // Create test vehicle
    const vehId = 'test_veh_ret_' + Date.now();
    const vehRes = await fetch(`${API_URL}/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: vehId,
            customerId: custId,
            make: 'Mercedes',
            model: 'C-Class',
            type: 'Sedan',
            plate: 'MH 02 RETURN',
            fuel: 'Petrol',
            transmission: 'Automatic'
        })
    });
    if (!vehRes.ok) throw new Error('Failed to create vehicle');
    console.log('Created test vehicle:', vehId);

    // Create test marshal
    const marshalId = 'test_marshal_ret_' + Date.now();
    const marshalPhoneNum = '+91' + Math.floor(6000000000 + Math.random() * 4000000000);
    const marshalEmailAddr = 'verify_marshal_ret_' + Date.now() + '@redrivo.com';
    const marshalRes = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: marshalId,
            name: 'Return Marshal',
            phone: marshalPhoneNum,
            email: marshalEmailAddr,
            role: 'marshal',
            password: 'password',
            status: 'active'
        })
    });
    if (!marshalRes.ok) throw new Error('Failed to create marshal');
    console.log('Created test marshal:', marshalId);

    // Approve Marshal KYC
    const kycRes = await fetch(`${API_URL}/users/${marshalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kycStatus: 'approved' })
    });
    if (!kycRes.ok) throw new Error('Failed to approve marshal KYC');
    console.log('Approved marshal KYC');

    // Fetch garages to pick one
    const garageListRes = await fetch(`${API_URL}/garages`);
    const garages = await garageListRes.json();
    if (garages.length === 0) throw new Error('No garages found in DB to test with');
    const testGarage = garages[0];
    console.log('Selected test garage:', testGarage.id, '-', testGarage.name);

    // Create Return-Only service request
    const reqId = 'test_req_ret_' + Date.now();
    const reqRes = await fetch(`${API_URL}/service-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: reqId,
            customerId: custId,
            vehicleId: vehId,
            garageId: testGarage.id,
            date: new Date().toISOString().split('T')[0],
            issue: 'Return Delivery Only',
            serviceType: 'HealthCheck',
            bookingFlow: 'garage_return',
            pickupDropType: 'Drop',
            pickup_address: testGarage.name + ' (' + testGarage.address + ')',
            drop_address: 'Customer Home Location',
            status: 'pending'
        })
    });
    if (!reqRes.ok) throw new Error('Failed to create service request');
    console.log('Created Return-Only service request:', reqId);

    // Marshal accepts the pickup request
    const acceptRes = await fetch(`${API_URL}/service-requests/${reqId}/accept-pickup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marshalId })
    });
    if (!acceptRes.ok) throw new Error('Failed to accept pickup request');
    const acceptData = await acceptRes.json();
    const tripId = acceptData.tripId;
    console.log('Marshal accepted pickup. Generated Trip ID:', tripId);
    console.log('Generated OTPs:', {
        garagePickupOtp: acceptData.garagePickupOtp,
        deliveryOtp: acceptData.deliveryOtp
    });

    // Check that the trip is in status 'ready_for_delivery'
    const tripsRes = await fetch(`${API_URL}/trips`);
    const allTrips = await tripsRes.json();
    const trip = allTrips.find(t => t.id === tripId);
    if (!trip) throw new Error('Trip not found in DB');
    console.log('Initial Trip status:', trip.status);
    if (trip.status !== 'ready_for_delivery') {
        throw new Error(`Expected initial status to be 'ready_for_delivery', got: ${trip.status}`);
    }

    // Try transitioning to out_for_delivery without media and without verifying OTP (SHOULD FAIL)
    console.log('Attempting transition to out_for_delivery without OTP/media...');
    const failTransitionRes = await fetch(`${API_URL}/trips/${tripId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'out_for_delivery' })
    });
    console.log('Transition status code:', failTransitionRes.status);
    const failTransitionData = await failTransitionRes.json();
    console.log('Error message (expected):', failTransitionData.error);
    if (failTransitionRes.status !== 400) {
        throw new Error('Transition should have failed with 400');
    }

    // Verify Garage Pickup OTP
    console.log('Verifying Garage Pickup OTP...');
    const verifyPickupOtpRes = await fetch(`${API_URL}/trips/${tripId}/verify-garage-pickup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: acceptData.garagePickupOtp })
    });
    if (!verifyPickupOtpRes.ok) throw new Error('Failed to verify Garage Pickup OTP');
    console.log('Garage Pickup OTP Verified successfully!');

    // Upload required media for Handover 3 (odometer_pickup_garage + 360_pickup_garage)
    console.log('Uploading media for Handover 3 (Garage Pickup)...');
    const dummyBlob = Buffer.from('dummy-image-content');
    
    // Odo Photo
    const fdOdo = new FormData();
    fdOdo.append('referenceId', tripId);
    fdOdo.append('type', 'odometer_pickup_garage');
    fdOdo.append('file', new Blob([dummyBlob], { type: 'image/jpeg' }), 'odo_pick.jpg');
    let uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdOdo });
    if (!uploadRes.ok) throw new Error('Odometer pickup upload failed');

    // 360 Walkaround
    const fdVid = new FormData();
    fdVid.append('referenceId', tripId);
    fdVid.append('type', '360_pickup_garage');
    fdVid.append('file', new Blob([dummyBlob], { type: 'video/webm' }), '360_pick.webm');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdVid });
    if (!uploadRes.ok) throw new Error('360 pickup walkaround video upload failed');
    console.log('Handover 3 media uploaded successfully.');

    // Transition to out_for_delivery (SHOULD SUCCEED NOW)
    console.log('Transitioning status to out_for_delivery...');
    const startDeliveryRes = await fetch(`${API_URL}/trips/${tripId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'out_for_delivery' })
    });
    if (!startDeliveryRes.ok) throw new Error('Failed to transition to out_for_delivery');
    console.log('Trip successfully transitioned to OUT_FOR_DELIVERY');

    // --- Handover 4 (Marshal -> Customer) ---
    console.log('\n--- Handover 4: Complete Delivery to Customer ---');

    // Upload final media first (odometer_end + 360_delivery)
    console.log('Uploading media for Handover 4...');
    const fdOdoEnd = new FormData();
    fdOdoEnd.append('referenceId', tripId);
    fdOdoEnd.append('type', 'odometer_end');
    fdOdoEnd.append('file', new Blob([dummyBlob], { type: 'image/jpeg' }), 'odo_end.jpg');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdOdoEnd });
    if (!uploadRes.ok) throw new Error('Odometer end upload failed');

    const fdVidEnd = new FormData();
    fdVidEnd.append('referenceId', tripId);
    fdVidEnd.append('type', '360_delivery');
    fdVidEnd.append('file', new Blob([dummyBlob], { type: 'video/webm' }), '360_end.webm');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdVidEnd });
    if (!uploadRes.ok) throw new Error('360 delivery walkaround video upload failed');
    console.log('Handover 4 media uploaded successfully.');

    // Submit delivery media
    console.log('Submitting delivery media details...');
    const submitMediaRes = await fetch(`${API_URL}/trips/${tripId}/submit-delivery-media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ odometer: 1025 })
    });
    if (!submitMediaRes.ok) throw new Error('Failed to submit final delivery media details');
    console.log('Final odometer details submitted successfully.');

    // Complete delivery with customer Delivery OTP
    console.log('Completing delivery with Customer Delivery OTP...');
    const completeRes = await fetch(`${API_URL}/trips/${tripId}/complete-delivery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: acceptData.deliveryOtp, odometer: 1025 })
    });
    if (!completeRes.ok) throw new Error('Failed to complete delivery');
    const completeData = await completeRes.json();
    console.log('Delivery Completed! Commission Credited:', completeData.commissionCredited);
    console.log('--- E2E RETURN-ONLY FLOW SUCCESSFULLY VALIDATED! ---');
}

runTests().catch(e => {
    console.error('VERIFICATION TEST FAILED:', e.message);
    process.exit(1);
});
