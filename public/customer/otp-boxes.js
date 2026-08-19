/**
 * ReDrivo Global OTP Box Controller
 * Powers all 6-box OTP inputs across Customer, Garage, and Marshal portals.
 * Auto-advance, backspace, paste, and aggregation into hidden <input> for backend compatibility.
 */
(function () {
  'use strict';

  function initOtpBoxes() {
    document.querySelectorAll('.otp-boxes').forEach(function (group) {
      var targetId = group.getAttribute('data-target');
      var boxes = Array.from(group.querySelectorAll('.otp-box'));

      function syncHidden() {
        var val = boxes.map(function (b) { return b.value; }).join('');
        var hidden = document.getElementById(targetId);
        if (hidden) {
          hidden.value = val;
          try {
            hidden.dispatchEvent(new Event('input', { bubbles: true }));
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {}
        }
      }

      boxes.forEach(function (box, idx) {
        // Numeric input only
        box.addEventListener('input', function () {
          var v = box.value.replace(/[^0-9]/g, '');
          box.value = v ? v[v.length - 1] : '';
          syncHidden();
          if (box.value && idx < boxes.length - 1) {
            boxes[idx + 1].focus();
          }
          // Visual: filled state
          box.classList.toggle('otp-box--filled', !!box.value);
        });

        // Backspace to previous
        box.addEventListener('keydown', function (e) {
          if (e.key === 'Backspace' && !box.value && idx > 0) {
            boxes[idx - 1].value = '';
            boxes[idx - 1].classList.remove('otp-box--filled');
            boxes[idx - 1].focus();
            syncHidden();
          }
          // Arrow key navigation
          if (e.key === 'ArrowLeft' && idx > 0) boxes[idx - 1].focus();
          if (e.key === 'ArrowRight' && idx < boxes.length - 1) boxes[idx + 1].focus();
        });

        // Select all on focus
        box.addEventListener('focus', function () {
          setTimeout(function () { box.select(); }, 0);
        });
      });

      // Paste handling — distribute digits across boxes
      group.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text') || '';
        if (text.length > 200) text = text.substring(0, 200); // Prevent Clipboard Bomb
        var digits = text.replace(/[^0-9]/g, '').split('').slice(0, 6);
        digits.forEach(function (d, i) {
          if (boxes[i]) {
            boxes[i].value = d;
            boxes[i].classList.add('otp-box--filled');
          }
        });
        syncHidden();
        // Focus next empty or last
        var nextEmpty = boxes.find(function (b) { return !b.value; });
        (nextEmpty || boxes[boxes.length - 1]).focus();
      });
    });
  }

  // Provide a helper to clear all boxes for a given group target id
  window.clearOtpBoxes = function (targetId) {
    var groups = document.querySelectorAll('.otp-boxes[data-target="' + targetId + '"]');
    groups.forEach(function (group) {
      group.querySelectorAll('.otp-box').forEach(function (b) {
        b.value = '';
        b.classList.remove('otp-box--filled');
      });
    });
    var hidden = document.getElementById(targetId);
    if (hidden) hidden.value = '';
  };

  // Auto-fill OTP from backend dev hint (replaces direct .value sets)
  window.fillOtpBoxes = function (targetId, code) {
    var groups = document.querySelectorAll('.otp-boxes[data-target="' + targetId + '"]');
    groups.forEach(function (group) {
      var boxes = group.querySelectorAll('.otp-box');
      String(code).split('').slice(0, 6).forEach(function (d, i) {
        if (boxes[i]) {
          boxes[i].value = d;
          boxes[i].classList.add('otp-box--filled');
        }
      });
    });
    var hidden = document.getElementById(targetId);
    if (hidden) {
      hidden.value = String(code).slice(0, 6);
      try {
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOtpBoxes);
  } else {
    initOtpBoxes();
  }
})();
