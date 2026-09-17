/**
 * ReDrivo Global KYC Validation Library
 * Enforces strict Indian document format rules across all portals.
 * Include ONCE in each portal HTML after all other scripts.
 */
(function (window) {
    'use strict';

    // ─── PAN CARD ─────────────────────────────────────────────────────────────
    // Format: AAAAA9999A — 5 uppercase letters, 4 digits, 1 uppercase letter
    window.initPanInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '10');
        el.setAttribute('placeholder', 'ABCDE1234F');
        el.style.letterSpacing = '2px';
        el.style.textTransform = 'uppercase';

        el.addEventListener('input', function () {
            var raw = el.value.toUpperCase();
            var result = '';
            for (var i = 0; i < raw.length && i < 10; i++) {
                var ch = raw[i];
                if (i < 5) {
                    // positions 0-4: letters only
                    if (/[A-Z]/.test(ch)) result += ch;
                } else if (i < 9) {
                    // positions 5-8: digits only
                    if (/[0-9]/.test(ch)) result += ch;
                } else {
                    // position 9: letter only
                    if (/[A-Z]/.test(ch)) result += ch;
                }
            }
            el.value = result;
            el.dispatchEvent(new Event('change'));
        });

        el.addEventListener('keypress', function (e) {
            var pos = el.selectionStart;
            var ch = String.fromCharCode(e.which || e.keyCode).toUpperCase();
            if (pos < 5 && !/[A-Za-z]/.test(ch)) { e.preventDefault(); return; }
            if (pos >= 5 && pos < 9 && !/[0-9]/.test(ch)) { e.preventDefault(); return; }
            if (pos === 9 && !/[A-Za-z]/.test(ch)) { e.preventDefault(); return; }
        });
    };

    window.validatePan = function (val) {
        return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test((val || '').toUpperCase().trim());
    };

    // ─── AADHAAR ──────────────────────────────────────────────────────────────
    // Format: 12 digits only (stored/validated without spaces)
    window.initAadhaarInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '14'); // 12 digits + 2 hyphens for display
        el.setAttribute('placeholder', '1234-5678-9012');
        el.setAttribute('inputmode', 'numeric');

        el.addEventListener('input', function () {
            var digits = el.value.replace(/\D/g, '').slice(0, 12);
            // Format with hyphens: XXXX-XXXX-XXXX
            var formatted = digits.replace(/(\d{4})(?=\d)/g, '$1-');
            el.value = formatted;
            el.dispatchEvent(new Event('change'));
        });

        el.addEventListener('keypress', function (e) {
            if (!/[0-9]/.test(String.fromCharCode(e.which || e.keyCode))) {
                e.preventDefault();
            }
        });
    };

    window.getAadhaarDigits = function (el) {
        return (el ? el.value : '').replace(/\D/g, '');
    };

    window.validateAadhaar = function (val) {
        var digits = (val || '').replace(/\D/g, '');
        return /^[2-9][0-9]{11}$/.test(digits); // 12 digits, first digit 2-9
    };

    // ─── DRIVING LICENSE ──────────────────────────────────────────────────────
    // Format: SS-YY-NNNNNNN  (state code 2 letters, 2-digit year, 7 digits)
    // e.g. MH12-2010-1234567 or DL0120100123456
    // We accept the loose format: 2 letters + 2 digits + any remaining digits (min 4)
    window.initDLInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '16');
        el.setAttribute('placeholder', 'MH12 20101234567');
        el.style.textTransform = 'uppercase';

        el.addEventListener('input', function () {
            var raw = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            var result = '';
            for (var i = 0; i < raw.length && i < 15; i++) {
                var ch = raw[i];
                if (i < 2) {
                    if (/[A-Z]/.test(ch)) result += ch;
                } else {
                    if (/[0-9]/.test(ch)) result += ch;
                }
            }
            el.value = result;
            el.dispatchEvent(new Event('change'));
        });

        el.addEventListener('keypress', function (e) {
            var pos = el.selectionStart;
            var ch = String.fromCharCode(e.which || e.keyCode).toUpperCase();
            if (pos < 2 && !/[A-Za-z]/.test(ch)) { e.preventDefault(); return; }
            if (pos >= 2 && !/[0-9]/.test(ch)) { e.preventDefault(); return; }
        });
    };

    window.validateDL = function (val) {
        var clean = (val || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return /^[A-Z]{2}[0-9]{11,13}$/.test(clean);
    };

    // ─── ACCOUNT HOLDER NAME ──────────────────────────────────────────────────
    // Only letters, spaces, dots (no numbers, no special chars)
    window.initBankNameInput = function (el) {
        if (!el) return;
        el.setAttribute('placeholder', 'Name as per Passbook');

        el.addEventListener('input', function () {
            var clean = el.value.replace(/[^A-Za-z\s.]/g, '');
            if (el.value !== clean) el.value = clean;
        });

        el.addEventListener('keypress', function (e) {
            var ch = String.fromCharCode(e.which || e.keyCode);
            if (!/[A-Za-z\s.]/.test(ch)) e.preventDefault();
        });
    };

    window.validateBankName = function (val) {
        return /^[A-Za-z\s.]{2,100}$/.test((val || '').trim());
    };

    // ─── ACCOUNT NUMBER ───────────────────────────────────────────────────────
    // 9 to 18 digits only
    window.initAccountNumberInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '18');
        el.setAttribute('placeholder', '000000000000');
        el.setAttribute('inputmode', 'numeric');

        el.addEventListener('input', function () {
            var clean = el.value.replace(/\D/g, '').slice(0, 18);
            if (el.value !== clean) el.value = clean;
        });

        el.addEventListener('keypress', function (e) {
            if (!/[0-9]/.test(String.fromCharCode(e.which || e.keyCode))) {
                e.preventDefault();
            }
        });
    };

    window.validateAccountNumber = function (val) {
        return /^[0-9]{9,18}$/.test((val || '').trim());
    };

    // ─── IFSC CODE ────────────────────────────────────────────────────────────
    // Format: AAAA0NNNNNN — 4 uppercase letters, digit 0, 6 alphanumeric
    window.initIFSCInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '11');
        el.setAttribute('placeholder', 'SBIN0001234');
        el.style.textTransform = 'uppercase';

        el.addEventListener('input', function () {
            var raw = el.value.toUpperCase();
            var result = '';
            for (var i = 0; i < raw.length && i < 11; i++) {
                var ch = raw[i];
                if (i < 4) {
                    if (/[A-Z]/.test(ch)) result += ch;
                } else if (i === 4) {
                    if (ch === '0') result += ch;
                } else {
                    if (/[A-Z0-9]/.test(ch)) result += ch;
                }
            }
            el.value = result;
        });

        el.addEventListener('keypress', function (e) {
            var pos = el.selectionStart;
            var ch = String.fromCharCode(e.which || e.keyCode).toUpperCase();
            if (pos < 4 && !/[A-Za-z]/.test(ch)) { e.preventDefault(); return; }
            if (pos === 4 && ch !== '0') { e.preventDefault(); return; }
            if (pos > 4 && !/[A-Za-z0-9]/.test(ch)) { e.preventDefault(); return; }
        });
    };

    window.validateIFSC = function (val) {
        return /^[A-Z]{4}0[A-Z0-9]{6}$/.test((val || '').toUpperCase().trim());
    };

    // ─── EMAIL ────────────────────────────────────────────────────────────────
    window.validateEmail = function (val) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((val || '').trim());
    };

    // ─── FULL NAME ────────────────────────────────────────────────────────────
    window.initFullNameInput = function (el) {
        if (!el) return;
        el.addEventListener('input', function () {
            var clean = el.value.replace(/[^A-Za-z\s.'-]/g, '');
            if (el.value !== clean) el.value = clean;
        });
        el.addEventListener('keypress', function (e) {
            if (!/[A-Za-z\s.'"-]/.test(String.fromCharCode(e.which || e.keyCode))) {
                e.preventDefault();
            }
        });
    };

    window.validateFullName = function (val) {
        return /^[A-Za-z\s.'"-]{2,100}$/.test((val || '').trim());
    };

    // ─── INLINE ERROR HELPER ──────────────────────────────────────────────────
    // Inject CSS animations dynamically if not already present
    if (typeof document !== 'undefined' && !document.getElementById('kyc-validation-styles')) {
        var style = document.createElement('style');
        style.id = 'kyc-validation-styles';
        style.textContent = '\
            @keyframes kyc-pulse-border {\
                0%, 100% {\
                    border-color: #ef4444;\
                    box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);\
                }\
                50% {\
                    border-color: rgba(239, 68, 68, 0.2);\
                    box-shadow: 0 0 2px rgba(239, 68, 68, 0.2);\
                }\
            }\
            .kyc-error-blink {\
                animation: kyc-pulse-border 0.6s ease-in-out infinite !important;\
                border: 2px solid #ef4444 !important;\
                outline: none !important;\
            }\
        ';
        document.head.appendChild(style);
    }

    window.setKYCFieldError = function (el, message) {
        if (!el) return;
        var errId = el.id + '__kyc_err';
        var existing = document.getElementById(errId);
        if (message) {
            el.classList.add('kyc-error-blink');
            if (!existing) {
                var err = document.createElement('div');
                err.id = errId;
                err.style.cssText = 'color:#ef4444;font-size:0.72rem;margin-top:4px;font-weight:600;';
                el.parentNode.insertBefore(err, el.nextSibling);
            }
            document.getElementById(errId).textContent = 'Invalid: ' + message;

            // State Removal: Remove blink and error text when user interacts (focus, input, click, change)
            var clearFn = function () {
                el.classList.remove('kyc-error-blink');
                window.clearKYCFieldError(el);
                el.removeEventListener('focus', clearFn);
                el.removeEventListener('input', clearFn);
                el.removeEventListener('change', clearFn);
                el.removeEventListener('click', clearFn);
            };
            el.addEventListener('focus', clearFn);
            el.addEventListener('input', clearFn);
            el.addEventListener('change', clearFn);
            el.addEventListener('click', clearFn);
        } else {
            el.classList.remove('kyc-error-blink');
            if (existing) existing.remove();
        }
    };

    window.clearKYCFieldError = function (el) {
        window.setKYCFieldError(el, null);
    };

    window.initConfirmAccountNumberInput = function (el) {
        if (!el) return;
        el.setAttribute('maxlength', '18');
        el.setAttribute('placeholder', '000000000000');
        el.setAttribute('inputmode', 'numeric');

        el.addEventListener('input', function () {
            var clean = el.value.replace(/\D/g, '').slice(0, 18);
            if (el.value !== clean) el.value = clean;
        });

        el.addEventListener('keypress', function (e) {
            if (!/[0-9]/.test(String.fromCharCode(e.which || e.keyCode))) {
                e.preventDefault();
            }
        });
    };

    var INDIAN_BANKS = [
        "State Bank of India",
        "HDFC Bank",
        "ICICI Bank",
        "Axis Bank",
        "Punjab National Bank",
        "Bank of Baroda",
        "Canara Bank",
        "Union Bank of India",
        "Bank of India",
        "Indian Bank",
        "Central Bank of India",
        "UCO Bank",
        "Bank of Maharashtra",
        "Punjab & Sind Bank",
        "IndusInd Bank",
        "Yes Bank",
        "Kotak Mahindra Bank",
        "Federal Bank",
        "IDFC First Bank",
        "Bandhan Bank",
        "South Indian Bank",
        "Karnataka Bank",
        "Karur Vysya Bank",
        "Jammu & Kashmir Bank",
        "City Union Bank",
        "Tamilnad Mercantile Bank",
        "Indian Overseas Bank",
        "DBS Bank India",
        "Standard Chartered Bank",
        "HSBC India",
        "Citibank India",
        "Paytm Payments Bank",
        "Airtel Payments Bank",
        "Jio Payments Bank",
        "India Post Payments Bank",
        "Fino Payments Bank",
        "AU Small Finance Bank",
        "Equitas Small Finance Bank",
        "Ujjivan Small Finance Bank",
        "Jana Small Finance Bank"
    ];

    window.initBankSearchInput = function (searchEl, dropdownEl, hiddenEl) {
        if (!searchEl || !dropdownEl || !hiddenEl) return;
        
        searchEl.addEventListener('input', function () {
            var rawVal = searchEl.value.trim();
            var val = rawVal.toLowerCase();
            dropdownEl.innerHTML = '';
            
            // Sync current input value directly so it is never empty if user types manually
            hiddenEl.value = rawVal;
            
            if (!val) {
                dropdownEl.style.display = 'none';
                hiddenEl.value = '';
                return;
            }
            
            var matches = INDIAN_BANKS.filter(function (b) {
                return b.toLowerCase().includes(val);
            });
            
            if (matches.length === 0) {
                var noMatchesItem = document.createElement('div');
                noMatchesItem.className = 'suggestion-item';
                noMatchesItem.style.color = '#ef4444';
                noMatchesItem.style.cursor = 'default';
                noMatchesItem.textContent = 'No matching banks found';
                dropdownEl.appendChild(noMatchesItem);
                dropdownEl.style.display = 'block';
                return;
            }
            
            matches.forEach(function (bank) {
                var item = document.createElement('div');
                item.className = 'suggestion-item';
                item.textContent = bank;
                item.addEventListener('click', function () {
                    searchEl.value = bank;
                    hiddenEl.value = bank;
                    dropdownEl.style.display = 'none';
                    searchEl.dispatchEvent(new Event('input'));
                    searchEl.dispatchEvent(new Event('change'));
                    hiddenEl.dispatchEvent(new Event('input'));
                    hiddenEl.dispatchEvent(new Event('change'));
                });
                dropdownEl.appendChild(item);
            });
            
            dropdownEl.style.display = 'block';
        });

        searchEl.addEventListener('focus', function () {
            if (searchEl.value.trim().length > 0) {
                searchEl.dispatchEvent(new Event('input'));
            }
        });
        
        document.addEventListener('click', function (e) {
            if (e.target !== searchEl && e.target !== dropdownEl) {
                dropdownEl.style.display = 'none';
            }
        });
    };

    // ─── FULL KYC FORM VALIDATOR ─────────────────────────────────────────────
    // Returns array of error strings. Empty array = valid.
    window.validateKYCForm = function (fields) {
        var errors = [];

        if (fields.name !== undefined && !validateFullName(fields.name)) {
            errors.push('Full Name must contain only letters (min 2 characters).');
        }
        if (fields.email !== undefined && !validateEmail(fields.email)) {
            errors.push('Please enter a valid Email Address.');
        }
        if (fields.pan !== undefined && !validatePan(fields.pan)) {
            errors.push('PAN Number must be in format ABCDE1234F (5 letters, 4 digits, 1 letter).');
        }
        if (fields.aadhaar !== undefined && !validateAadhaar(fields.aadhaar)) {
            errors.push('Aadhaar Number must be exactly 12 digits.');
        }
        if (fields.dl !== undefined && !validateDL(fields.dl)) {
            errors.push('Driving License must start with 2 state letters followed by digits (e.g. MH12...).');
        }
        if (fields.bankName !== undefined && !validateBankName(fields.bankName)) {
            errors.push('Account Holder Name must contain only letters and spaces.');
        }
        if (fields.accountNumber !== undefined && !validateAccountNumber(fields.accountNumber)) {
            errors.push('Account Number must be 9–18 digits only.');
        }
        if (fields.ifsc !== undefined && !validateIFSC(fields.ifsc)) {
            errors.push('IFSC Code must be in format SBIN0001234 (4 letters, 0, 6 alphanumeric).');
        }

        return errors;
    };

})(window);
