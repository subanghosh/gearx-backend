const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', 'utf8');

// 1. Update the UI inside reviewMarshalKYC
const oldHtml = `                    <div style="display:flex; gap:12px; margin-top:10px;">
                        <button class="btn btn-secondary" style="flex:1;" onclick="closeModal('modal-review-kyc')">Close</button>
                        \${(m.kycStatus || m.kycstatus) === 'pending_approval' ? \`
                            <button class="btn btn-danger" style="flex:1;" onclick="rejectMarshal('\${m.id}')">
                                <i data-lucide="user-minus"></i> Reject
                            </button>
                            <button class="btn btn-success" style="flex:1.5;" onclick="approveMarshal('\${m.id}')">
                                <i data-lucide="check-circle"></i> Approve Marshal
                            </button>
                        \` : ''}
                    </div>`;

const newHtml = `                    <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                        \${(m.kycStatus || m.kycstatus) === 'pending_approval' ? \`
                            <div style="display:flex; gap:12px;">
                                <button class="btn btn-danger" style="flex:1;" onclick="rejectMarshal('\${m.id}')">
                                    <i data-lucide="user-minus"></i> Reject
                                </button>
                                <button class="btn btn-success" style="flex:1.5;" onclick="approveMarshal('\${m.id}')">
                                    <i data-lucide="check-circle"></i> Approve Marshal
                                </button>
                            </div>
                        \` : \`
                            <div style="display:flex; gap:12px;">
                                <button class="btn" style="flex:1; background:rgba(255,165,0,0.1); color:orange; border:1px solid rgba(255,165,0,0.3);" onclick="requestKycReverification('\${m.id}')">
                                    <i data-lucide="refresh-ccw"></i> Re-verify KYC
                                </button>
                                <button class="btn btn-danger" style="flex:1;" onclick="terminateUser('\${m.id}')">
                                    <i data-lucide="user-x"></i> Terminate Account
                                </button>
                            </div>
                        \`}
                        <button class="btn btn-secondary" style="width:100%;" onclick="closeModal('modal-review-kyc')">Close</button>
                    </div>`;

if(content.includes(oldHtml)) content = content.replace(oldHtml, newHtml);

// 2. Add the JS functions below rejectMarshal
const fns = `
async function requestKycReverification(userId) {
    if(!await window.customShowConfirm('Are you sure you want to request KYC re-verification? This will lock their app until they submit documents again.')) return;
    try {
        const res = await fetch(\`\${API_URL}/users/\${userId}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kycStatus: 'pending_submission' })
        });
        if (!res.ok) throw new Error('Failed to request re-verification');
        await showAlert('Success', 'KYC Re-verification requested.', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => renderMarshals(document.getElementById('app')));
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function terminateUser(userId) {
    if(!await window.customShowConfirm('Are you sure you want to terminate this account? They will be permanently locked out.')) return;
    try {
        const res = await fetch(\`\${API_URL}/users/\${userId}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'terminated' })
        });
        if (!res.ok) throw new Error('Failed to terminate account');
        await showAlert('Success', 'Account terminated successfully.', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => renderMarshals(document.getElementById('app')));
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}
`;

const rejectMarker = `}

function filterMarshalsByProximity(val) {`;

if(content.includes(rejectMarker)) content = content.replace(rejectMarker, `}\n${fns}\nfunction filterMarshalsByProximity(val) {`);

fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/app.js', content);

// Cache bust
let html = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/index.html', 'utf8');
html = html.replace(/app\.js\?v=\d+/, 'app.js?v=10');
fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/Anti_Gravity/index.html', html);
console.log('CRM UI updated.');
