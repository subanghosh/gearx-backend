const fs = require('fs');

async function runTests() {
    const API_URL = 'http://localhost:3000/api';
    console.log('--- STARTING E2E LOGISTICS FLOW & OTP GATE VALIDATION ---');

    // Create test customer
    const custId = 'test_cust_' + Date.now();
    const custPhoneNum = '+91' + Math.floor(6000000000 + Math.random() * 4000000000);
    const custEmailAddr = 'verify_cust_' + Date.now() + '@redrivo.com';
    const custRes = await fetch(`${API_URL}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: custId,
            name: 'Verification Customer',
            phone: custPhoneNum,
            email: custEmailAddr
        })
    });
    if (!custRes.ok) throw new Error('Failed to create customer');
    console.log('Created test customer:', custId, custPhoneNum, custEmailAddr);

    // Create test vehicle
    const vehId = 'test_veh_' + Date.now();
    const vehRes = await fetch(`${API_URL}/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: vehId,
            customerId: custId,
            make: 'Tesla',
            model: 'Model S',
            type: 'Sedan',
            plate: 'MH 01 VERIFY',
            fuel: 'Electric',
            transmission: 'Automatic'
        })
    });
    if (!vehRes.ok) throw new Error('Failed to create vehicle');
    console.log('Created test vehicle:', vehId);

    // Create test marshal
    const marshalId = 'test_marshal_' + Date.now();
    const marshalPhoneNum = '+91' + Math.floor(6000000000 + Math.random() * 4000000000);
    const marshalEmailAddr = 'verify_marshal_' + Date.now() + '@redrivo.com';
    const marshalRes = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: marshalId,
            name: 'Verification Marshal',
            phone: marshalPhoneNum,
            email: marshalEmailAddr,
            role: 'marshal',
            password: 'password',
            status: 'active'
        })
    });
    if (!marshalRes.ok) throw new Error('Failed to create marshal');
    console.log('Created test marshal:', marshalId, marshalPhoneNum, marshalEmailAddr);

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

    // --- TEST 1: standard garage pickup flow (Home to Garage) ---
    console.log('\n--- TEST Leg 1: Standard Garage Flow ---');
    const reqId = 'test_req_' + Date.now();
    const reqRes = await fetch(`${API_URL}/service-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: reqId,
            customerId: custId,
            vehicleId: vehId,
            garageId: testGarage.id,
            date: new Date().toISOString().split('T')[0],
            issue: 'USP Maintenance',
            serviceType: 'HealthCheck',
            bookingFlow: 'garage_standard',
            pickupDropType: 'Pickup',
            pickup_address: 'Customer Home Location',
            drop_address: testGarage.name + ' (' + testGarage.address + ')',
            status: 'pending'
        })
    });
    if (!reqRes.ok) throw new Error('Failed to create service request');
    console.log('Created standard garage service request:', reqId);

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
        otp1: acceptData.otp1,
        garageDropoffOtp: acceptData.garageDropoffOtp,
        garagePickupOtp: acceptData.garagePickupOtp,
        deliveryOtp: acceptData.deliveryOtp
    });

    // Attempting status transition to in_transit without media upload (SHOULD FAIL)
    console.log('Trying to transition to in_transit without walkaround/odo media...');
    const failTransitionRes = await fetch(`${API_URL}/trips/${tripId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_transit', startOdometer: 1000 })
    });
    console.log('Transition without media status:', failTransitionRes.status);
    const failTransitionData = await failTransitionRes.json();
    console.log('Error message (expected):', failTransitionData.error);
    if (failTransitionRes.status !== 400) throw new Error('Status transition without media did not fail with 400');

    // Verify OTP-1
    console.log('Verifying Handover OTP-1...');
    const verifyOtp1Res = await fetch(`${API_URL}/trips/${tripId}/verify-otp-1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: acceptData.otp1 })
    });
    if (!verifyOtp1Res.ok) throw new Error('Failed to verify OTP-1');
    console.log('OTP-1 Verified successfully!');

    // Upload required media for Handover 1 (odometer_start + 360_pickup)
    console.log('Uploading media for Handover 1...');
    const dummyBlob = Buffer.from('dummy-image-content');
    
    // Odo Photo
    const fdOdo = new FormData();
    fdOdo.append('referenceId', tripId);
    fdOdo.append('type', 'odometer_start');
    fdOdo.append('file', new Blob([dummyBlob], { type: 'image/jpeg' }), 'odo.jpg');
    let uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdOdo });
    if (!uploadRes.ok) throw new Error('Odometer start upload failed');

    // 360 Walkaround
    const fdVid = new FormData();
    fdVid.append('referenceId', tripId);
    fdVid.append('type', '360_pickup');
    fdVid.append('file', new Blob([dummyBlob], { type: 'video/webm' }), '360.webm');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdVid });
    if (!uploadRes.ok) throw new Error('360 pickup walkaround video upload failed');
    console.log('Handover 1 media uploaded successfully.');

    // Now transition to in_transit (SHOULD SUCCEED)
    console.log('Transitioning status to in_transit...');
    const transitionRes = await fetch(`${API_URL}/trips/${tripId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_transit', startOdometer: 1000 })
    });
    if (!transitionRes.ok) throw new Error('Failed to transition status to in_transit after uploading media');
    console.log('Trip successfully transitioned to IN_TRANSIT');

    // --- Handover 2 (Marshal -> Garage) ---
    console.log('\n--- Handover 2: Dropoff to Garage ---');
    
    // Verify Garage Dropoff OTP
    console.log('Verifying Garage Dropoff OTP...');
    const verifyDropoffOtpRes = await fetch(`${API_URL}/trips/${tripId}/verify-garage-dropoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: acceptData.garageDropoffOtp })
    });
    if (!verifyDropoffOtpRes.ok) throw new Error('Failed to verify Garage Dropoff OTP');
    console.log('Garage Dropoff OTP Verified successfully!');

    // Upload required media for Handover 2 (odometer_dropoff_garage + 360_dropoff_garage)
    console.log('Uploading media for Handover 2...');
    const fdOdoDrop = new FormData();
    fdOdoDrop.append('referenceId', tripId);
    fdOdoDrop.append('type', 'odometer_dropoff_garage');
    fdOdoDrop.append('file', new Blob([dummyBlob], { type: 'image/jpeg' }), 'odo_drop.jpg');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdOdoDrop });
    if (!uploadRes.ok) throw new Error('Odometer dropoff upload failed');

    const fdVidDrop = new FormData();
    fdVidDrop.append('referenceId', tripId);
    fdVidDrop.append('type', '360_dropoff_garage');
    fdVidDrop.append('file', new Blob([dummyBlob], { type: 'video/webm' }), '360_drop.webm');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdVidDrop });
    if (!uploadRes.ok) throw new Error('360 dropoff walkaround video upload failed');
    console.log('Handover 2 media uploaded successfully.');

    // Transition to at_garage
    console.log('Transitioning status to at_garage...');
    const dropoffRes = await fetch(`${API_URL}/trips/${tripId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'at_garage', garageDropOdometer: 1012 })
    });
    if (!dropoffRes.ok) throw new Error('Failed to transition to at_garage');
    console.log('Trip successfully transitioned to AT_GARAGE');

    // --- Handover 3 (Garage -> Marshal) ---
    console.log('\n--- Handover 3: Garage Pickup / Ready for Delivery ---');
    
    // Garage marks the order ready for delivery, generating garagePickupOtp & deliveryOtp
    console.log('Garage marking order ready for delivery...');
    const readyRes = await fetch(`${API_URL}/trips/${tripId}/ready-for-delivery`, { method: 'POST' });
    if (!readyRes.ok) throw new Error('Failed to mark trip ready for delivery');
    const readyData = await readyRes.json();
    console.log('Garage Pickup OTP generated:', readyData.garagePickupOtp);
    console.log('Delivery OTP generated:', readyData.deliveryOtp);

    // Verify Garage Pickup OTP
    console.log('Verifying Garage Pickup OTP...');
    const verifyPickupOtpRes = await fetch(`${API_URL}/trips/${tripId}/verify-garage-pickup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: readyData.garagePickupOtp })
    });
    if (!verifyPickupOtpRes.ok) throw new Error('Failed to verify Garage Pickup OTP');
    console.log('Garage Pickup OTP Verified successfully!');

    // Upload required media for Handover 3 (odometer_pickup_garage + 360_pickup_garage)
    console.log('Uploading media for Handover 3...');
    const fdOdoPick = new FormData();
    fdOdoPick.append('referenceId', tripId);
    fdOdoPick.append('type', 'odometer_pickup_garage');
    fdOdoPick.append('file', new Blob([dummyBlob], { type: 'image/jpeg' }), 'odo_pick.jpg');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdOdoPick });
    if (!uploadRes.ok) throw new Error('Odometer pickup upload failed');

    const fdVidPick = new FormData();
    fdVidPick.append('referenceId', tripId);
    fdVidPick.append('type', '360_pickup_garage');
    fdVidPick.append('file', new Blob([dummyBlob], { type: 'video/webm' }), '360_pick.webm');
    uploadRes = await fetch(`${API_URL}/media`, { method: 'POST', body: fdVidPick });
    if (!uploadRes.ok) throw new Error('360 pickup walkaround video upload failed');
    console.log('Handover 3 media uploaded successfully.');

    // Transition to out_for_delivery
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
        body: JSON.stringify({ otp: readyData.deliveryOtp, odometer: 1025 })
    });
    if (!completeRes.ok) throw new Error('Failed to complete delivery');
    const completeData = await completeRes.json();
    console.log('Delivery Completed! Commission Credited:', completeData.commissionCredited);
    console.log('--- ALL OTP GATES AND AUDITING COMPLIANCE SUCCESSFULLY VALIDATED! ---');
}

runTests().catch(e => {
    console.error('VERIFICATION TEST FAILED:', e.message);
    process.exit(1);
});
