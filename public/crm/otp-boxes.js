/**
 * ReDrivo CRM OTP Box Controller
 * Powers 6-box OTP input for the Operational Command Center.
 * Includes idempotent initialization, auto-advance, backspace, paste, and hidden input aggregation.
 */
(function () {
  'use strict';

  function initOtpBoxes() {
    document.querySelectorAll('.otp-boxes').forEach(function (group) {
      if (group.getAttribute('data-otp-initialized') === 'true') return;
      group.setAttribute('data-otp-initialized', 'true');

      var targetId = group.getAttribute('data-target');
      var boxes = Array.from(group.querySelectorAll('.otp-box'));

      function syncHidden() {
        var val = boxes.map(function (b) { return b.value; }).join('');
        var hidden = document.getElementById(targetId);
        if (hidden) hidden.value = val;
      }

      boxes.forEach(function (box, idx) {
        box.addEventListener('input', function () {
          var v = box.value.replace(/[^0-9]/g, '');
          box.value = v ? v[v.length - 1] : '';
          syncHidden();
          if (box.value && idx < boxes.length - 1) {
            boxes[idx + 1].focus();
          }
          box.classList.toggle('otp-box--filled', !!box.value);
        });

        box.addEventListener('keydown', function (e) {
          if (e.key === 'Backspace' && !box.value && idx > 0) {
            boxes[idx - 1].value = '';
            boxes[idx - 1].classList.remove('otp-box--filled');
            boxes[idx - 1].focus();
            syncHidden();
          }
          if (e.key === 'ArrowLeft' && idx > 0) boxes[idx - 1].focus();
          if (e.key === 'ArrowRight' && idx < boxes.length - 1) boxes[idx + 1].focus();
        });

        box.addEventListener('focus', function () {
          setTimeout(function () { box.select(); }, 0);
        });
      });

      group.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text');
        var digits = text.replace(/[^0-9]/g, '').split('').slice(0, 6);
        digits.forEach(function (d, i) {
          if (boxes[i]) {
            boxes[i].value = d;
            boxes[i].classList.add('otp-box--filled');
          }
        });
        syncHidden();
        var nextEmpty = boxes.find(function (b) { return !b.value; });
        (nextEmpty || boxes[boxes.length - 1]).focus();
      });
    });
  }

  window.initOtpBoxes = initOtpBoxes;

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
    if (hidden) hidden.value = String(code).slice(0, 6);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOtpBoxes);
  } else {
    initOtpBoxes();
  }
})();
