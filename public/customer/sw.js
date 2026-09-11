// ReDrivo Customer App - Service Worker for Web Push Notifications
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { title: 'ReDrivo Notification', body: event.data ? event.data.text() : 'You have an update.' };
    }

    const title = payload.title || payload.notification?.title || 'ReDrivo Alert';
    const body = payload.body || payload.notification?.body || 'New update regarding your booking.';
    const options = {
        body,
        icon: '/images/redrivo-logo.png',
        badge: '/images/redrivo-logo.png',
        data: payload.data || {},
        vibrate: [200, 100, 200],
        tag: payload.tag || 'redrivo-alert'
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if ('focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow('/customer/');
            }
        })
    );
});
