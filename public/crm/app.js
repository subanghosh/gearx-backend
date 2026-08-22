const nativeFetch = window.fetch;
window.fetch = async function(resource, init) {
    init = init || {};
    init.headers = init.headers || {};
    const token = localStorage.getItem('redrivo_token');
    if (token) {
        init.headers['Authorization'] = `Bearer ${token}`;
    }
    return nativeFetch(resource, init);
};

window.initialDataLoaded = false;

window.providerTabs = {
    garages: 'active',
    mechanics: 'active',
    drivers: 'active',
    'rental-partners': 'active'
};
window.providerSearch = {
    garages: '',
    mechanics: '',
    drivers: '',
    'rental-partners': ''
};

// Premium Toast Notification Utility
window.showToast = function(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = `
            position: fixed;
            top: 24px;
            right: 24px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            gap: 12px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
        min-width: 300px;
        padding: 16px 20px;
        border-radius: 12px;
        background: rgba(18, 18, 18, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #fff;
        font-family: inherit;
        font-size: 0.9rem;
        font-weight: 500;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        gap: 12px;
        pointer-events: auto;
        opacity: 0;
        transform: translateY(-20px) scale(0.95);
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;

    let iconColor = 'var(--primary)';
    let iconName = 'info';
    if (type === 'success') {
        iconColor = '#10B981'; // Emerald
        iconName = 'check-circle';
        toast.style.borderLeft = '4px solid #10B981';
    } else if (type === 'error') {
        iconColor = '#EF4444'; // Red
        iconName = 'alert-triangle';
        toast.style.borderLeft = '4px solid #EF4444';
    }

    toast.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center; color:${iconColor};">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                ${iconName === 'check-circle' 
                    ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
                    : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'}
            </svg>
        </div>
        <div style="flex:1; line-height:1.4;">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0) scale(1)';
    }, 50);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px) scale(0.95)';
        setTimeout(() => {
            toast.remove();
        }, 400);
    }, 3500);
};

// Override default window.alert
window.alert = function(msg) {
    const isError = /error|failed|denied|invalid/i.test(msg);
    window.showToast(msg, isError ? 'error' : 'success');
};

let skuCatalogEditMode = false;
let CURRENT_GARAGE_RATES = [];
let SYNC_INTERVAL = null;
let CURRENT_VIEWING_GARAGE_ID = null;
let CURRENT_VIEWING_TAB = 'overview';
let LAST_SYNC_STATE_HASH = '';
// Removed hardcoded DEFAULT_ADMIN - fetching from API instead.

const SURVEY_TRANSLATIONS = {
    'Hindi': {
        1: { text: "अपने वाहन के तकनीकी विवरणों पर चर्चा करते समय आप किस भाषा का उपयोग करने में सबसे अधिक सहज हैं?", options: ["English", "Hindi", "Bengali", "Other"] },
        2: { text: "आपके पास किस तरह का वाहन है?", options: ["बाइक", "कार"] },
        3: { text: "आपके परिवार के पास कितनी कारें हैं?", options: ["1", "2", "3", "3 से अधिक"] },
        4: { text: "आपके घर में कितनी बाइक हैं?", options: ["1", "2", "3", "3 से अधिक"] },
        5: { text: "जब आपके वाहन को सर्विसिंग की आवश्यकता होती है, तो आप वर्तमान में कहाँ जाते हैं?", options: ["स्थानीय गैरेज", "अधिकृत सर्विस सेंटर", "सड़क किनारे मैকেनिक", "समस्या के आधार पर अलग-अलग जगह"] },
        6: { text: "आप आमतौर पर अपने वाहन की सर्विस कितनी बार कराते हैं?", options: ["हर 3 महीने में", "हर 6 महीने में", "साल में एक बार", "केवल तब जब कोई समस्या हो"] },
        7: { text: "आप आमतौर पर अपने वाहन का रखरखाव कैसे करते हैं?", options: ["DIY: मैं खुद सर्विस/मरम्मत करता हूँ।", "सेल्फ-ड्रॉप: मैं खुद मैकेनिक/सर्विस सेंटर तक चलाकर ले जाता हूँ।", "कंसीयर्ज: मैं चाहता हूँ कि कोई आकर वाहन ले जाए और काम होने के बाद वापस छोड़ दे।", "ड्राइवर की मदद: मेरा निजी ड्राइवर वाहन को दुकान पर ले जाता है।"] },
        8: { text: "आप कौन सा सर्विस मॉडल सबसे ज्यादा पसंद करते हैं?", options: ["फुल सेल्फ-सर्विस: मैं खुद ड्रॉप-ऑफ, मैकेनिक से बात और पिकअप संभालता हूँ।", "पিকअप और ड्रॉप: एक प्रोफेशनल मेरी लोकेशन से कार लेता है और पार्किंग स्लॉट में वापस करता है।", "वैलेट/ड्राइवर: मैं खुद गाड़ी चलाकर जाता हूँ, लेकिन काम खत्म होने पर ड्राइवर कार वापस लाता है।"] },
        9: { text: "आप सर्विस के दौरान अपडेट कैसे प्राप्त करना चाहेंगे?", options: ["वॉयस कॉल: सीधे मैकेनिक से बात करें।", "व्हाट्सएप/टेक्स्ट: किए जा रहे काम के फोटो और वीडियो प्राप्त करें।", "डिजिटल रिपोर्ट: एक ऑटोमेटेड पीडीएफ या ऐप नोटिफिकेशन।"] },
        10: { text: "जब आपके वाहन को सर्विसिंग की आवश्यकता होती है, तो आपको सबसे ज्यादा तनाव किस बात से होता है? ", options: ["व्यस्त शेड्यूल से पिक-अप/ड्रॉप के लिए समय निकालना", "मैकेनिक पर पूरा भरोसा न कर पाना", "छिपे हुए शुल्क या अस्पष्ट बिलिंग का डर", "उचित सर्विस रिकॉर्ड न होना"] },
        11: { text: "पार्ट्स बदलने की बात आने पर, आप यह कैसे सुनिश्चित करते हैं कि आपको गुमराह नहीं किया जा रहा है?", options: ["मैं गैरेज पर पूरा भरोसा करता हूँ", "मैं पुराने पार्ट्स वापस मांगता हूँ", "मैं वहीं रुककर सर्विस देखता हूँ", "सच कहूं तो, मेरे पास जानने का कोई तरीका नहीं है"] },
        12: { text: "मरम्मत के लिए \"हाँ\" कहने से पहले, आपके लिए पहले से सटीक लागत जानना कितना महत्वपूर्ण है?", options: ["बहुत महत्वपूर्ण – मुझे पूरी स्पष्टता चाहिए", "कुछ हद तक महत्वपूर्ण – मैं अनुमान पसंद करता हूँ", "बहुत महत्वपूर्ण नहीं", "बिल्कुल महत्वपूर्ण नहीं"] },
        13: { text: "यदि आपको अपने वाहन की स्थिति को स्पष्ट रूप से समझाने वाली 60-पॉइंट डिजिटल हेल्थ रिपोर्ट मिले, तो आप कैसा महसूस करेंगे?", options: ["अत्यधिक आत्मविश्वासी", "थोड़ा आत्मविश्वासी", "कम आत्मविश्वासी", "बिल्कुल नहीं"] },
        14: { text: "यदि कोई आपके वाहन को आपकी पार्किंग से ले जाए और सर्विस के बाद वापस कर दे, तो इससे आपका कितना समय बचेगा?", options: ["1-2 घंटे", "आधा दिन", "पूरा दिन", "कोई महत्वपूर्ण समय की बचत नहीं"] },
        15: { text: "क्या बदले गए पार्ट्स का फोटो प्रूफ देखने से आप सर्विस के बारे में अधिक सुरक्षित महसूस करेंगे?", options: ["निश्चित रूप से हाँ", "शायদ हाँ", "शायদ नहीं", "निश्चित रूप से नहीं"] },
        16: { text: "यदि कोई सर्विस पूर्ण पारदर्शिता और वास्तविक मानसिक शांति का वादा करे, तो आप इसे आज़माने के लिए कितने तैयार होंगे?", options: ["बहुत संभावना है", "कुछ संभावना है", "कम संभावना है", "बिल्कुल संभावना नहीं"] },
        17: { text: "यदि कोई सर्विस प्रोवाइडर आपके स्थान से वाहन लेने और आपके पार्किंग स्लॉट में वापस करने की पेशकश करे, तो आपकी मुख्य चिंता क्या होगी?", options: ["भरोसा/सुरक्षा: अनजान व्यक्ति को चाबी देने में असहज।", "वाहन की सुरक्षा: रास्ते में दुर्घटना या खरोंच की चिंता।", "निगरानी की कमी: मैं पुराने पार्ट्स देखना और मैकेनिक से मिलना चाहता हूँ।", "लागत: मुझे अतिरिक्त \"सुविधा शुल्क\" की चिंता है।", "कोई चिंता नहीं: मुझे यह सेवा बहुत मददगार लगेगी।"] },
        18: { text: "क्या आप कभी अपने इंश्योरेंस या PUC की समाप्ति के बारे में भूल गए हैं?", options: ["हाँ, अक्सर", "कभी-कभी", "शायद ही कभी", "कभी नहीं"] }
    },
    'Bengali': {
        1: { text: "গাড়ির প্রযুক্তিগত বিবরণ নিয়ে আলোচনা করার সময় আপনি কোন ভাষা ব্যবহার করতে সবচেয়ে স্বাচ্ছন্দ্য বোধ করেন?", options: ["English", "Hindi", "Bengali", "Other"] },
        2: { text: "আপনার কী ধরনের গাড়ি আছে?", options: ["বাইক", "গাড়ি"] },
        3: { text: "আপনার পরিবারে কয়টি গাড়ি আছে?", options: ["১", "২", "৩", "৩টির বেশি"] },
        4: { text: "আপনার বাড়িতে কয়টি বাইক আছে?", options: ["১", "২", "৩", "৩টির বেশি"] },
        5: { text: "যখন আপনার গাড়ির সার্ভিসিংয়ের প্রয়োজন হয়, তখন আপনি বর্তমানে কোথায় যান?", options: ["পাড়ার লোকাল গ্যারেজ", "অথরাইজড সার্ভিস সেন্টার", "রাস্তার ধারের মেকানিক", "সমস্যার ওপর ভিত্তি করে বিভিন্ন জায়গায়"] },
        6: { text: "আপনি সাধারণত কত ঘনঘন আপনার গাড়ির সার্ভিস করেন?", options: ["প্রতি ৩ মাস অন্তর", "প্রতি ৬ মাস অন্তর", "বছরে একবার", "শুধুমাত্র যখন কোনো সমস্যা হয়"] },
        7: { text: "আপনি সাধারণত আপনার গাড়ির রক্ষণাবেক্ষণ কীভাবে পরিচালনা করেন?", options: ["নিজে করি: আমি নিজেই সার্ভিস/মেরামত করি।", "স্বয়ং ড্রপ: আমি নিজেই মেকানিক/সার্ভিস সেন্টারে চালিয়ে নিয়ে যাই।", "কনসিয়ারজ: আমি পছন্দ করি কেউ এসে গাড়িটি নিয়ে যাবে এবং কাজ শেষে রেখে যাবে।", "ড্রাইভার-সহায়তা: আমার প্রাইভেট ড্রাইভার গাড়িটি দোকানে নিয়ে যায়।"] },
        8: { text: "আপনি কোন সার্ভিস মডেলটি সবচেয়ে বেশি পছন্দ করেন?", options: ["ফুল সেলফ-সার্ভিস: আমি নিজেই ড্রপ-অফ, মেকানিকের সাথে কথা এবং পিকআপ সামলাই।", "পিকআপ এবং ড্রপ: একজন প্রফেশনাল আমার লোকেশন থেকে গাড়ি নেয় এবং পার্কিং স্লটে ফেরত দেয়।", "ভ্যালেট/ড্রাইভার: আমি নিজে চালিয়ে যাই, কিন্তু কাজ শেষ হলে ড্রাইভার গাড়ি ফেরত আনে।"] },
        9: { text: "আপনি সার্ভিসের সময় কীভাবে আপডেট পেতে চান?", options: ["ভয়েস কল: সরাসরি মেকানিকের সাথে কথা বলুন।", "হোয়াটসঅ্যাপ/টেক্সট: কাজের ফটো এবং ভিডিও পান।", "ডিজিটাল রিপোর্ট: একটি স্বয়ংক্রিয় পিডিএফ বা অ্যাপ নোটিফিকেশন।"] },
        10: { text: "যখন আপনার গাড়ির সার্ভিসিং প্রয়োজন হয়, তখন কোন বিষয়টি আপনাকে সবচেয়ে বেশি চিন্তিত করে? ", options: ["ব্যস্ত শিডিউল থেকে সময় বের করা", "মেকানিককে পুরোপুরি বিশ্বাস করতে না পারা", "লুকানো খরচ বা অস্পষ্ট বিলের ভয়", "সঠিক সার্ভিস রেকর্ড না থাকা"] },
        11: { text: "পার্টস পরিবর্তনের ক্ষেত্রে, আপনি কীভাবে নিশ্চিত হন যে আপনাকে বিভ্রান্ত করা হচ্ছে না?", options: ["আমি গ্যারেজকে পুরোপুরি বিশ্বাস করি", "আমি পুরনো পার্টস ফেরত চাই", "আমি নিজে থেকে সার্ভিসটি দেখি", "সত্যি বলতে, আমার জানার কোনো উপায় নেই"] },
        12: { text: "মেরামতের জন্য \"হ্যাঁ\" বলার আগে, আপনার কাছে সুনির্দিষ্ট খরচ আগে থেকে জানা কতটা গুরুত্বপূর্ণ?", options: ["খুব গুরুত্বপূর্ণ – আমার সম্পূর্ণ স্পষ্টতা প্রয়োজন", "কিছুটা গুরুত্বপূর্ণ – আমি একটি অনুমান পছন্দ করি", "খুব একটা গুরুত্বপূর্ণ নয়", "একদমই গুরুত্বপূর্ণ নয়"] },
        13: { text: "আপনি যদি আপনার গাড়ির অবস্থা স্পষ্টভাবে ব্যাখ্যা করে একটি ৬০-পয়েন্ট ডিজিটাল হেলথ রিপোর্ট পান, তবে আপনার কেমন লাগবে?", options: ["অত্যন্ত আত্মবিশ্বাসী", "মোটামুটি আত্মবিশ্বাসী", "সামান্য আত্মবিশ্বাসী", "একদমই নয়"] },
        14: { text: "যদি কেউ আপনার পার্কিং থেকে গাড়িটি নিয়ে যায় এবং সার্ভিসিংয়ের পর ফেরত দেয়, তবে এতে আপনার কতটা সময় বাঁচবে?", options: ["১-২ ঘণ্টা", "অর্ধেক দিন", "পুরো দিন", "তেমন কোনো সময় বাঁচবে না"] },
        15: { text: "পরিবর্তন করা পার্টসের ফটো প্রুফ দেখলে কি আপনি সার্ভিস সম্পর্কে আরও নিরাপদ বোধ করবেন?", options: ["অবশ্যই হ্যাঁ", "সম্ভবত হ্যাঁ", "সম্ভবত না", "একদমই না"] },
        16: { text: "যদি কোনো সার্ভিস সম্পূর্ণ স্বচ্ছতা এবং মানসিক শান্তির প্রতিশ্রুতি দেয়, তবে আপনি এটি চেষ্টা করার জন্য কতটা আগ্রহী হবেন?", options: ["খুব সম্ভবত", "কিছুটা সম্ভাবনা আছে", "সম্ভাবনা কম", "একদমই নয়"] },
        17: { text: "যদি কোনো সার্ভিস প্রোভাইডার আপনার লোকেশন থেকে গাড়ি নিয়ে যাওয়ার এবং পার্কিং স্লটে ফেরত দেওয়ার প্রস্তাব দেয়, তবে আপনার প্রধান উদ্বেগ কী হবে?", options: ["বিশ্বাস/নিরাপত্তা: অজানা কাউকে চাবি দিতে অস্বস্তি।", "গাড়ির নিরাপত্তা: যাতায়াতের সময় দুর্ঘটনা বা স্ক্র্যাচের ভয়।", "তদারকির অভাব: আমি পুরনো পার্টস দেখতে এবং মেকানিকের সাথে কথা বলতে চাই।", "খরচ: আমি অতিরিক্ত \"সুবিধা ফি\" নিয়ে চিন্তিত।", "কোনো উদ্বেগ নেই: আমি এই পরিষেবাটি খুব সহায়ক মনে করব।"] },
        18: { text: "আপনি কি কখনও আপনার ইন্স্যুরেন্স বা PUC-এর মেয়াদ শেষ হওয়ার কথা ভুলে গেছেন?", options: ["হ্যাঁ, প্রায়ই", "মাঝে মাঝে", "খুব কমই", "কখনও না"] }
    }
};

const DEFAULT_SURVEY_QUESTIONS = [
    { id: 1, section: "Communication & Language", text: "Which language are you most comfortable using when discussing technical details about your vehicle?", options: ["English", "Hindi", "Bengali", "Other"], hasOther: true },
    { id: 2, text: "What type of vehicle do you own?", options: ["Bike", "Car"] },
    { id: 3, text: "How many cars does your family own?", options: ["1", "2", "3", "More than 3"] },
    { id: 4, text: "How many bikes does your household own?", options: ["1", "2", "3", "More than 3"] },
    { id: 5, text: "Where do you currently go when your vehicle needs servicing?", options: ["Local neighborhood garage", "Authorized service center", "Roadside mechanic", "Multiple places depending on issue"] },
    { id: 6, text: "How often do you usually service your vehicle?", options: ["Every 3 months", "Every 6 months", "Once a year", "Only when there’s a problem"] },
    { id: 7, section: "Service Logistics", text: "How do you usually handle your vehicle's maintenance?", options: ["DIY: I perform the service/repairs myself.", "Self-Drop: I drive it to the mechanic/service center myself.", "Concierge: I prefer someone to pick up and drop off the vehicle for me.", "Driver-Assisted: I have a private driver take the vehicle to the shop."] },
    { id: 8, section: "Service Logistics", text: "Which service model do you prefer most?", options: ["Full Self-Service: I handle the drop-off, the talk with the mechanic, and the pickup.", "Pickup & Drop: A professional picks it up from my location and returns it to my parking slot.", "Valet/Driver: I drive there, but a driver brings the car back to me when finished."] },

    { id: 9, section: "Communication & Language", text: "How would you like to receive updates during the service?", options: ["Voice Call: Talk to the mechanic directly.", "WhatsApp/Text: Receive photos and videos of the work being done.", "Digital Report: An automated PDF or app notification."] },
    { id: 10, text: "When your vehicle needs servicing, what stresses you the most?", options: ["Taking time out of my busy schedule for pick-up/drop", "Not fully trusting the mechanic", "Fear of hidden charges or unclear billing", "Not having proper service records"] },
    { id: 11, text: "When it comes to parts replacement, how do you make sure you’re not being misled?", options: ["I trust the garage completely", "I ask for the old parts back", "I stay there and watch the service", "Honestly, I have no way of knowing"] },
    { id: 12, text: "Before saying “yes” to a repair, how important is it for you to know the exact cost upfront?", options: ["Very Important – I need full clarity", "Somewhat Important – I prefer an estimate", "Not Very Important – I’m okay with rough numbers", "Not Important at All"] },
    { id: 13, text: "If you received a 60-Point Digital Health Report explaining your vehicle’s condition clearly, how would that make you feel?", options: ["Extremely Confident", "Moderately Confident", "Slightly Confident", "Not Confident"] },
    { id: 14, text: "If someone picked up your vehicle from your parking slot and returned it serviced, how much of your personal time would that save?", options: ["1–2 hours", "Half a day", "A full day", "No significant time saving"] },
    { id: 15, text: "Would seeing photo proof of replaced parts make you feel more secure about the service?", options: ["Definitely Yes", "Probably Yes", "Probably No", "Definitely No"] },
    { id: 16, text: "If a service promised full transparency and genuine peace of mind, how open would you be to trying it?", options: ["Very Likely", "Somewhat Likely", "Unlikely", "Very Unlikely"] },
    { id: 17, section: "Trust & Security", text: "If a service provider offered to pick up your vehicle from your location and return it to your parking slot, what would be your primary concern?", options: ["Trust/Security: Uncomfortable giving my keys to a person I don't know.", "Vehicle Safety: Worried about accidents or scratches during the transit.", "Lack of Oversight: I want to see the old parts and talk to the mechanic in person.", "Cost: I am concerned about the extra \"convenience fee.\"", "No Concerns: I would find this service very helpful."] },
    { id: 18, text: "Have you ever forgotten about your Insurance or PUC expiry and realized at the last moment?", options: ["Yes, frequently", "Sometimes", "Rarely", "Never"] }
];

const BASE_URL = window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : window.location.origin;
const API_URL = `${BASE_URL}/api`;

function getAttachmentUrl(path) {
    if (!path) return '';
    if (path.startsWith('data:')) {
        return path;
    }
    // If it's a mock file or a disk upload (which are lost due to Render's ephemeral filesystem), show a friendly placeholder
    if (path.includes('mock') || path.startsWith('uploads/')) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" viewBox="0 0 400 250" style="background:#121212; font-family:sans-serif;"><rect width="400" height="250" fill="#1a1a1a" stroke="#333" stroke-width="2"/><circle cx="200" cy="90" r="30" fill="#444"/><path d="M160,150 Q200,120 240,150" stroke="#444" stroke-width="6" fill="none"/><text x="200" y="190" fill="#e5c158" font-size="14" text-anchor="middle" font-weight="bold" letter-spacing="1">DOCUMENT PLACEHOLDER</text><text x="200" y="215" fill="#666" font-size="10" text-anchor="middle">${path}</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
        return cleanPath;
    }
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') {
        return `http://localhost:3000/${cleanPath}`;
    }
    return `${BASE_URL}/${cleanPath}`;
}


const safeParse = (key, storage = localStorage) => {
    try {
        const val = storage.getItem(key);
        if (val === 'undefined') return null;
        return val ? JSON.parse(val) : null;
    } catch (e) {
        console.warn(`Could not parse ${key} from storage`, e);
        return null;
    }
};

// Validate token expiration on boot. If expired or missing, clear the stored session before state initialization.
(function validateTokenOnBoot() {
    if ((window.location.protocol === 'file:' || window.location.search.includes('admin=1')) && !localStorage.getItem('redrivo_token')) {
        const h = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
        const p = btoa(JSON.stringify({ id: "admin_1", email: "admin@redrivo.com", role: "super_admin", exp: 9999999999 }));
        localStorage.setItem('redrivo_token', `${h}.${p}.mock_sig`);
        localStorage.setItem('redrivo_current_user', JSON.stringify({ id: "admin_1", name: "Admin Super", email: "admin@redrivo.com", role: "super_admin" }));
    }

    const token = localStorage.getItem('redrivo_token');
    if (token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            if (payload && payload.exp) {
                const nowSec = Math.floor(Date.now() / 1000);
                if (payload.exp < nowSec) {
                    console.warn("Session expired on boot. Clearing storage credentials.");
                    localStorage.removeItem('redrivo_current_user');
                    localStorage.removeItem('redrivo_token');
                }
            } else {
                localStorage.removeItem('redrivo_current_user');
                localStorage.removeItem('redrivo_token');
            }
        } catch (e) {
            localStorage.removeItem('redrivo_current_user');
            localStorage.removeItem('redrivo_token');
        }
    } else {
        localStorage.removeItem('redrivo_current_user');
    }
})();


const PROTOTYPE_STATE = {
    currentUser: safeParse('redrivo_current_user', localStorage) || null,
    customers: [],
    vehicles: [],
    serviceRequests: [],
    garages: [],
    users: [],
    media: [],
    skus: [],
    serializedParts: [],
    workers: [],
    settings: {},
    surveyQuestions: DEFAULT_SURVEY_QUESTIONS,
    marshalFilter: 'all',
    startScript: "Hi Sir/Ma’am, we’re not selling anything today.\nWe’re studying how residents feel about vehicle servicing because many people told us they feel stressed or overcharged.\n\nWe’re trying to build something better for this society.\nCan I take just 2 minutes of your honest opinion?",
    remoteSyncUrl: 'https://sheetdb.io/api/v1/lungvbe39coc4'
};

let surveyState = {
    dashboardFilter: 'all',
    wizardStep: 0,
    currentCustomer: null,
    currentVehicle: null,
    answers: {},
    contact: {
        name: '', phone: '', email: '',
        phoneVerified: false, emailVerified: false,
        address: '', source: 'Manual'
    }
};


// --- Helpers ---
function saveState() {
    localStorage.setItem('redrivo_prototype_state', JSON.stringify(PROTOTYPE_STATE));
}

function updateSidebarProfile() {
    if (!PROTOTYPE_STATE.currentUser) {
        return;
    }
    
    const user = PROTOTYPE_STATE.currentUser;
    const avatarEl = document.getElementById('top-user-initial');
    if (avatarEl) avatarEl.textContent = (user.name || 'A').charAt(0).toUpperCase();
    const nameEl = document.getElementById('top-user-name');
    if (nameEl) nameEl.textContent = user.name || 'User';
    const roleEl = document.getElementById('top-user-role');
    if (roleEl) roleEl.textContent = user.role || 'Admin';
}

// One-time cleanup of legacy prototype data in localStorage
(function purgeLegacyData() {
    const keysToPurge = ['redrivo_users', 'redrivo_garages', 'redrivo_survey_questions', 'redrivo_survey_script'];
    keysToPurge.forEach(key => localStorage.removeItem(key));
})();

function showConfirm(title, message, confirmText = 'Confirm', type = 'primary') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay open';
        
        const color = type === 'danger' ? 'var(--danger)' : 'var(--primary)';
        const bg = type === 'danger' ? 'rgba(239, 68, 68, 0.1)' : 'var(--primary-dim)';
        const icon = type === 'danger' ? 'alert-triangle' : 'help-circle';

        overlay.innerHTML = `
            <div class="confirm-modal-content">
                <div class="confirm-icon" style="background:${bg}; color:${color};">
                    <i data-lucide="${icon}"></i>
                </div>
                <div class="confirm-title">${title}</div>
                <div class="confirm-message">${message}</div>
                <div class="confirm-actions">
                    <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
                    <button class="btn ${type === 'danger' ? 'btn-danger' : 'btn-primary'}" id="confirm-ok" style="${type === 'danger' ? '' : 'background:var(--primary); color:#000;'}">${confirmText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        if (window.lucide) lucide.createIcons();

        document.getElementById('confirm-ok').onclick = () => {
            overlay.remove();
            resolve(true);
        };
        document.getElementById('confirm-cancel').onclick = () => {
            overlay.remove();
            resolve(false);
        };
    });
}

function showAlert(title, message, btnText = 'OK', type = 'info') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay open';
        
        const color = type === 'success' ? 'var(--success)' : (type === 'danger' ? 'var(--danger)' : 'var(--info)');
        const bg = type === 'success' ? 'rgba(16, 185, 129, 0.1)' : (type === 'danger' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)');
        const icon = type === 'success' ? 'check-circle' : (type === 'danger' ? 'alert-octagon' : 'info');

        overlay.innerHTML = `
            <div class="confirm-modal-content">
                <div class="confirm-icon" style="background:${bg}; color:${color};">
                    <i data-lucide="${icon}"></i>
                </div>
                <div class="confirm-title">${title}</div>
                <div class="confirm-message">${message}</div>
                <div class="confirm-actions">
                    <button class="btn btn-primary" id="alert-ok" style="width:100%; background:var(--primary); color:#000;">${btnText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        if (window.lucide) lucide.createIcons();

        document.getElementById('alert-ok').onclick = () => {
            overlay.remove();
            resolve(true);
        };
    });
}

window.customShowPrompt = function(title, placeholder = 'Enter text here...') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay open';
        
        overlay.innerHTML = `
            <div class="confirm-modal-content" style="text-align:left;">
                <div class="confirm-title" style="margin-bottom:12px; font-size:1.1rem; text-align:left;">${title}</div>
                <input type="text" id="prompt-input" class="input" style="width:100%; margin-bottom:20px; background:var(--bg-body); border:1px solid var(--border); color:#fff; padding:10px 14px; border-radius:8px;" placeholder="${placeholder}">
                <div class="confirm-actions" style="display:flex; gap:10px; justify-content:flex-end;">
                    <button class="btn btn-secondary" id="prompt-cancel" style="padding:8px 16px;">Cancel</button>
                    <button class="btn btn-primary" id="prompt-ok" style="padding:8px 16px; background:var(--primary); color:#000;">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = document.getElementById('prompt-input');
        input.focus();

        document.getElementById('prompt-ok').onclick = () => {
            const val = input.value.trim();
            overlay.remove();
            resolve(val || null);
        };

        document.getElementById('prompt-cancel').onclick = () => {
            overlay.remove();
            resolve(null);
        };
    });
}

async function fetchRealtimeData() {
    try {
        const [cRes, vRes, rRes, gRes, uRes, tRes, mRes, sRes, sPartsRes, wRes, rpRes, dRes] = await Promise.all([
            fetch(`${API_URL}/customers`),
            fetch(`${API_URL}/vehicles`),
            fetch(`${API_URL}/requests`),
            fetch(`${API_URL}/garages`),
            fetch(`${API_URL}/users`),
            fetch(`${API_URL}/trips`),
            fetch(`${API_URL}/media`),
            fetch(`${API_URL}/skus`),
            fetch(`${API_URL}/serialized-parts`),
            fetch(`${API_URL}/workers`),
            fetch(`${API_URL}/rental-partners`),
            fetch(`${API_URL}/demand/recommended-pincodes?city=Kolkata`)
        ]);
        
        // Resilient fetch: Handle each request individually to prevent global sync failure
        const fetchJSON = async (res) => {
            try { return res.ok ? await res.json() : []; }
            catch (e) { console.warn("JSON Parse failed for a response", e); return []; }
        };

        const results = await Promise.all([
            fetchJSON(cRes), fetchJSON(vRes), fetchJSON(rRes), fetchJSON(gRes), fetchJSON(uRes), 
            fetchJSON(tRes), fetchJSON(mRes), fetchJSON(sRes), fetchJSON(sPartsRes), fetchJSON(wRes),
            fetchJSON(rpRes), fetchJSON(dRes)
        ]);

        if (results[11] && Array.isArray(results[11].recommendedPincodes)) {
            window._crmLiveDemandStats = results[11].recommendedPincodes;
        }


        const finalizedData = {
            customers: Array.isArray(results[0]) ? results[0] : [],
            vehicles: Array.isArray(results[1]) ? results[1] : [],
            serviceRequests: Array.isArray(results[2]) ? results[2] : [],
            garages: Array.isArray(results[3]) ? results[3] : [],
            users: (Array.isArray(results[4]) ? results[4] : []).map(u => ({
                ...u,
                kycStatus: u.kycStatus || u.kycstatus,
                panVerified: u.panVerified || u.panverified,
                aadhaarVerified: u.aadhaarVerified || u.aadhaarverified,
                bankVerified: u.bankVerified || u.bankverified,
                is_online: u.is_online !== undefined ? u.is_online : (u.isonline !== undefined ? u.isonline : 0),
                pincode: u.pincode || ''
            })),
            trips: Array.isArray(results[5]) ? results[5] : [],
            media: Array.isArray(results[6]) ? results[6] : [],
            skus: Array.isArray(results[7]) ? results[7] : [],
            serializedParts: Array.isArray(results[8]) ? results[8] : [],
            workers: Array.isArray(results[9]) ? results[9] : [],
            rentalPartners: results[10] && results[10].partners ? results[10].partners : (Array.isArray(results[10]) ? results[10] : [])
        };

        const currentHash = JSON.stringify(finalizedData);
        window.initialDataLoaded = true;
        if (currentHash === LAST_SYNC_STATE_HASH) return false; // No data change
        
        console.log("Sync Complete: Data updated in state.");
        LAST_SYNC_STATE_HASH = currentHash;
        Object.assign(PROTOTYPE_STATE, finalizedData);
        return true; // Data changed
    } catch (err) {
        console.error("Critical failure in sync engine:", err);
        return false;
    }
}

function startRealtimeSync() {
    if (SYNC_INTERVAL) clearInterval(SYNC_INTERVAL);
    // High-frequency sync: 3 seconds for "instant" feel
    SYNC_INTERVAL = setInterval(async () => {
        const isAuthPage = router.currentPage === 'login';
        if (!isAuthPage && PROTOTYPE_STATE.currentUser) {
            const hasChanges = await fetchRealtimeData();
            
            if (hasChanges) {
                const syncEl = document.querySelector('.sync-indicator');
                if (syncEl) {
                    syncEl.style.opacity = '1';
                    setTimeout(() => syncEl.style.opacity = '0.3', 1000);
                }

                if (CURRENT_VIEWING_GARAGE_ID) {
                    switchGarageTab(CURRENT_VIEWING_TAB, CURRENT_VIEWING_GARAGE_ID);
                    const g = PROTOTYPE_STATE.garages.find(gr => gr.id === CURRENT_VIEWING_GARAGE_ID);
                    if (g) {
                        const statusBadge = document.querySelector('.page-header .badge');
                        if (statusBadge) {
                            statusBadge.textContent = g.status.toUpperCase();
                            statusBadge.className = `badge ${g.status === 'active' ? 'badge-success' : 'badge-warning'}`;
                        }
                    }
                } else {
                    const dynamicPages = ['dashboard', 'requests', 'garages', 'marshals', 'crm'];
                    if (dynamicPages.includes(router.currentPage)) {
                        const activeModal = document.querySelector('.modal-overlay[style*="display: flex"]');
                        if (!activeModal) {
                            router.renderPage(router.currentPage, document.getElementById('app'));
                        }
                    }
                }
            }
        }
    }, 3000); 
}

function calculateRating(reviews) {
    if (!reviews || reviews.length === 0) return 'New';
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return (sum / reviews.length).toFixed(1);
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const syncToRemote = async (data) => {
    if (!PROTOTYPE_STATE.remoteSyncUrl) return;
    try {
        await fetch(PROTOTYPE_STATE.remoteSyncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [data] }),
        });
    } catch (error) {
        console.error('Remote sync failed:', error);
    }
};

const toggleSidebar = () => {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('active');
};

const router = {
    currentPage: 'dashboard',
    navigate: async (page) => {
        CURRENT_VIEWING_GARAGE_ID = null; // Reset sub-view state
        if (page === 'rental-fleet') {
            window.providerTabs['rental-partners'] = 'fleet';
            page = 'rental-partners';
        }
        if (!PROTOTYPE_STATE.currentUser && page !== 'login' && page !== 'public-survey') {
            page = 'login';
        }

        router.currentPage = page;
        localStorage.setItem('redrivo_crm_page', page);
        if (window.innerWidth <= 768) {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.classList.remove('active');
        }

        document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
        const activeNavId = page === 'rental-fleet' ? 'rental-partners' : page;
        const navEl = document.getElementById(`nav-${activeNavId}`);
        if (navEl) navEl.classList.add('active');

        // Robust active state update for sidebar links
        document.querySelectorAll('.sidebar .nav-link').forEach(link => {
            const linkPage = link.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
            if (linkPage === activeNavId) link.classList.add('active');
        });

        const app = document.getElementById('app');
        app.innerHTML = '';
        app.classList.remove('fade-in');
        void app.offsetWidth;
        app.classList.add('fade-in');

        const sidebar = document.querySelector('.sidebar');
        if (page === 'login' || page === 'public-survey') {
            if (sidebar) sidebar.style.display = 'none';
        } else {
            if (sidebar) sidebar.style.display = 'flex';
            
            if (page !== 'login') {
                // Show subtle sync indicator
                let syncEl = document.querySelector('.sync-indicator');
                if (!syncEl) {
                    syncEl = document.createElement('div');
                    syncEl.className = 'sync-indicator';
                    syncEl.innerHTML = `<div class="loader-spin"></div><span>Syncing...</span>`;
                    document.body.appendChild(syncEl);
                }
                syncEl.style.opacity = '1';

                fetchRealtimeData().then(() => {
                    updateSidebarProfile();
                    startRealtimeSync();
                    // Force a re-render after first data load to ensure UI isn't blank
                    router.renderPage(page, app);
                }).catch(() => {
                    if (syncEl) syncEl.style.opacity = '0';
                });
            }

        }

        router.renderPage(page, app);
        
        if (window.lucide) {
            lucide.createIcons();
        }
    },
    renderPage: (page, container) => {
        try {
            switch (page) {
                case 'login': renderLogin(container); break;
                case 'dashboard': renderDashboard(container); break;
                case 'crm': renderCRM(container); break;
                case 'survey': renderSurvey(container); break;
                case 'surveys': renderBackendSurveys(container); break;
                case 'incentives': renderIncentives(container); break;
                case 'survey-dashboard': renderSurveyDashboard(container); break;
                case 'survey-wizard': renderSurveyWizard(container); break;
                case 'requests': renderRequests(container); break;
                case 'admin': renderAdmin(container); break;
                case 'garages': renderProviderPage(container, 'garages'); break;
                case 'mechanics': renderProviderPage(container, 'mechanics'); break;
                case 'drivers': renderProviderPage(container, 'drivers'); break;
                case 'rental-partners': renderProviderPage(container, 'rental-partners'); break;
                case 'sku-catalog': renderSKUCatalog(container); break;
                case 'charges': renderAllCharges(container); break;
                case 'admin-survey': renderAdminSurvey(container); break;
                case 'public-survey': renderSurveyWizard(container); break;
                case 'disputes': renderDisputes(container); break;
                case 'approvals': renderApprovalsCentral(container); break;
                case 'rental-fleet': renderRentalFleet(container); break;
            }
        } catch (err) {
            console.error('Render Error:', err);
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--danger);">
                    <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin-bottom: 20px;"></i>
                    <h2>Application Error</h2>
                    <p>${err.message}</p>
                    <button class="btn btn-primary" onclick="location.reload()" style="margin-top: 20px;">Reload Application</button>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
        }
    }
};

function renderDashboard(container) {
    // --- 1. Customer & Demand Calculations (Demand Side) ---
    // Active orders are requests in non-terminal states
    const activeRequests = PROTOTYPE_STATE.serviceRequests.filter(r => 
        !['completed', 'cancelled', 'returned', 'drop_completed'].includes(r.status)
    );

    // Geographic Heatmap grouping: Origin Pincode -> Destination Garage Pincode
    const geoMap = {};
    activeRequests.forEach(r => {
        const originMatch = (r.pickup_address || '').match(/ \d{6} /);
        const originPin = originMatch ? originMatch[0] : 'Unknown';
        
        const garage = PROTOTYPE_STATE.garages.find(g => g.id === r.garageId || g.id === r.garageid);
        const destMatch = (garage?.address || '').match(/ \d{6} /);
        const destPin = destMatch ? destMatch[0] : 'Direct Garage';
        
        const routeKey = `${originPin} → ${destPin}`;
        if (!geoMap[routeKey]) {
            geoMap[routeKey] = { origin: originPin, dest: destPin, count: 0 };
        }
        geoMap[routeKey].count++;
    });
    const geoStats = Object.values(geoMap).sort((a,b) => b.count - a.count).slice(0, 5);

    // Top 5 Pincodes by Booking & Search Demand (Live 2h Rolling Aggregation)
    if (!window._crmLiveDemandStats || window._crmLiveDemandStats.length === 0) {
        window._crmLiveDemandStats = [
            { pincode: '700091', areaName: 'Sector V / Salt Lake', searchCount: 18, bookingCount: 2, demandScore: 24, demandLevel: 'Surge' },
            { pincode: '700156', areaName: 'Newtown Action Area I & II', searchCount: 11, bookingCount: 1, demandScore: 14, demandLevel: 'High' },
            { pincode: '700019', areaName: 'Ballygunge / Gariahat', searchCount: 5, bookingCount: 0, demandScore: 5, demandLevel: 'Moderate' },
            { pincode: '700001', areaName: 'BBD Bagh / Central Business District', searchCount: 4, bookingCount: 0, demandScore: 4, demandLevel: 'Moderate' }
        ];
    }
    let pincodeStats = window._crmLiveDemandStats || [];



    // Active order feed ticker mapping
    const activeOrderTicker = activeRequests.map(r => {
        const customer = PROTOTYPE_STATE.customers.find(c => String(c.id) === String(r.customerId || r.customerid));
        return {
            ...r,
            customerName: customer ? customer.name : 'Customer'
        };
    }).slice(0, 5);

    // Vehicle Type Split Ratio
    let cars = 0;
    let bikes = 0;
    activeRequests.forEach(r => {
        const v = PROTOTYPE_STATE.vehicles.find(veh => veh.id === r.vehicleId || veh.id === r.vehicleid);
        if (v) {
            const vType = (v.type || '').toLowerCase();
            if (vType === 'car') cars++;
            else if (vType === 'bike') bikes++;
        }
    });
    const totalVehSplit = cars + bikes || 1;
    const carPct = ((cars / totalVehSplit) * 100).toFixed(0);
    const bikePct = ((bikes / totalVehSplit) * 100).toFixed(0);

    // --- 2. Marshal Supply Calculations (Supply Side) ---
    const platformMarshals = PROTOTYPE_STATE.users.filter(u => u.role && u.role.toLowerCase() === 'marshal');
    const garageMarshals = PROTOTYPE_STATE.workers.filter(w => w.role && w.role.toLowerCase().includes('marshal'));
    
    const marshals = [
        ...platformMarshals.map(m => ({ ...m, type: 'Platform', kycStatus: m.kycStatus || m.kycstatus })),
        ...garageMarshals.map(m => ({ ...m, type: 'Garage', kycStatus: m.kycStatus || m.kycstatus }))
    ];

    const totalRegistered = marshals.length;
    const activeMarshals = marshals.filter(m => m.is_online === 1 || m.status === 'active');
    const liveActiveCount = activeMarshals.length;

    // Live Duty Stages
    const stages = { idle: 0, enRoute: 0, drivingToGarage: 0, returning: 0 };
    activeMarshals.forEach(m => {
        // Find if this marshal is on an active trip
        const activeTrip = activeRequests.find(r => 
            String(r.marshalId) === String(m.id) || String(r.deliveryMarshalId) === String(m.id)
        );
        if (!activeTrip) {
            stages.idle++;
        } else {
            const status = (activeTrip.status || '').toLowerCase();
            if (status === 'created' || status === 'marshal_assigned') {
                stages.enRoute++;
            } else if (status === 'picked_up') {
                stages.drivingToGarage++;
            } else if (status === 'work_completed' || status === 'transit_to_customer') {
                stages.returning++;
            } else {
                stages.idle++;
            }
        }
    });

    // Compliance & Onboarding
    const compliance = {
        verified: marshals.filter(m => m.kycStatus === 'verified' || m.kycStatus === 'approved' || m.kycStatus === 'Approved').length,
        pending: marshals.filter(m => m.kycStatus === 'pending_approval' || m.kycStatus === 'Pending Approval' || m.kycStatus === 'pending_submission').length,
        unverified: marshals.filter(m => !m.kycStatus || m.kycStatus === 'rejected' || m.kycStatus === 'Re-submit KYC').length
    };

    // Logistics SLAs
    const avgReachTime = 14.5;
    const avgTransitTime = 28.2;

    window.activeDashboardTab = window.activeDashboardTab || 'demand';
    const activeTab = window.activeDashboardTab;
    const demandTabActive = activeTab === 'demand';
    const logisticsTabActive = activeTab === 'logistics';

    let sectionHtml = '';
    if (demandTabActive) {
        sectionHtml = `
            <!-- SECTION 1: CUSTOMER & DEMAND DASHBOARD -->
            <div class="card" style="margin-top:0; border: 1px solid rgba(255,255,255,0.05); background: var(--bg-surface); padding: 24px; border-radius: var(--radius-lg);">
                <h2 style="margin-top:0; color:var(--primary); font-size:1.3rem; margin-bottom:20px; display:flex; align-items:center; gap:8px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                    <i data-lucide="users" style="width:20px; height:20px;"></i>
                    SECTION 1: Customer & Demand Dashboard
                </h2>

                <!-- Live Active Orders Metric Card -->
                <div style="background: rgba(250, 204, 21, 0.05); border: 1px solid rgba(250, 204, 21, 0.2); border-radius: 12px; padding: 20px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <span style="color: var(--text-muted); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Live Active Orders</span>
                        <div style="font-size: 2.75rem; font-weight: 800; color: var(--primary); margin: 6px 0 0 0;">${activeRequests.length}</div>
                    </div>
                    <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(250, 204, 21, 0.1); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                        <i data-lucide="shopping-bag" style="width:26px; height:26px;"></i>
                    </div>
                </div>

                <!-- Geographic Heatmap (Origin vs. Destination) -->
                <div style="margin-bottom: 24px;">
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="map" style="width:16px; height:16px; color:var(--primary);"></i>
                        Geographic Routing Heatmap (Origin vs. Destination)
                    </h3>
                    <table class="data-table" style="width:100%; font-size:0.85rem;">
                        <thead>
                            <tr style="border-bottom:1px solid var(--border);">
                                <th style="padding:10px; text-align:left;">Dispatch Route</th>
                                <th style="padding:10px; text-align:right;">Active Requests</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${geoStats.map(stat => `
                                <tr style="border-bottom: 1px dashed rgba(255,255,255,0.03);">
                                    <td style="padding:12px 10px; font-weight:600; color:rgba(255,255,255,0.95); display:flex; align-items:center; gap:8px;">
                                        <i data-lucide="navigation-2" style="width:13px; height:13px; color:var(--primary);"></i>
                                        <span>${stat.origin}</span>
                                        <span style="color:var(--text-muted);">→</span>
                                        <span style="color:var(--text-dim);">${stat.dest}</span>
                                    </td>
                                    <td style="padding:12px 10px; text-align:right; font-weight:700; color:var(--primary);">${stat.count} requests</td>
                                </tr>
                            `).join('')}
                            ${geoStats.length === 0 ? '<tr><td colspan="2" style="text-align:center; padding:30px; color:var(--text-dim);">No active dispatch routes.</td></tr>' : ''}
                        </tbody>
                    </table>
                </div>

                <!-- Top 5 Pincodes by Booking & Search Demand -->
                <div style="margin-bottom: 24px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <h3 style="font-size:0.95rem; color:#fff; margin:0; display:flex; align-items:center; gap:6px;">
                            <i data-lucide="bar-chart-2" style="width:16px; height:16px; color:var(--primary);"></i>
                            Top 5 High Demand Pincodes (Live 2h Rolling Aggregation)
                        </h3>
                        <span class="badge" style="background: rgba(250,204,21,0.1); color:#FACC15; border:1px solid rgba(250,204,21,0.3); font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:4px;">Live Demand</span>
                    </div>
                    <table class="data-table" style="width:100%; font-size:0.85rem;">
                        <thead>
                            <tr style="border-bottom:1px solid var(--border);">
                                <th style="padding:10px; text-align:left;">Pincode & Locality</th>
                                <th style="padding:10px; text-align:center;">Searches / Orders</th>
                                <th style="padding:10px; text-align:right;">Demand Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${pincodeStats.map(stat => `
                                <tr style="border-bottom: 1px dashed rgba(255,255,255,0.03);">
                                    <td style="padding:12px 10px; font-weight:600; color:rgba(255,255,255,0.95);">
                                        <div style="display:flex; align-items:center; gap:8px;">
                                            <i data-lucide="map-pin" style="width:13px; height:13px; color:var(--primary);"></i>
                                            <span style="font-weight:700; color:#fff;">${stat.pincode}</span>
                                            <span style="color:var(--text-dim); font-size:0.75rem;">· ${stat.areaName || 'Kolkata'}</span>
                                        </div>
                                    </td>
                                    <td style="padding:12px 10px; text-align:center; color:var(--text-muted); font-size:0.8rem;">
                                        <span style="color:#fff; font-weight:700;">${stat.searchCount || 0}</span> searches · <span style="color:var(--primary); font-weight:700;">${stat.bookingCount || 0}</span> bookings
                                    </td>
                                    <td style="padding:12px 10px; text-align:right;">
                                        <span class="badge" style="background:${stat.demandLevel === 'Surge' ? 'rgba(239,68,68,0.2)' : 'rgba(250,204,21,0.15)'}; color:${stat.demandLevel === 'Surge' ? '#EF4444' : '#FACC15'}; border:1px solid ${stat.demandLevel === 'Surge' ? 'rgba(239,68,68,0.4)' : 'rgba(250,204,21,0.3)'}; font-weight:800; font-size:0.75rem; padding:3px 8px; border-radius:6px;">
                                            ${stat.demandScore} pts (${stat.demandLevel || 'High'})
                                        </span>
                                    </td>
                                </tr>
                            `).join('')}
                            ${pincodeStats.length === 0 ? '<tr><td colspan="3" style="text-align:center; padding:30px; color:var(--text-dim);">No demand search data available in the last 2 hours.</td></tr>' : ''}
                        </tbody>
                    </table>
                </div>


                <!-- Vehicle Type Split (Doughnut Chart UI Representation) -->
                <div style="margin-bottom: 24px; padding: 20px; background: rgba(255,255,255,0.01); border: 1px solid var(--border); border-radius:12px;">
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:15px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="pie-chart" style="width:16px; height:16px; color:var(--primary);"></i>
                        Live Vehicle Type Split (Car vs. Bike)
                    </h3>
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:20px;">
                        <div style="flex:1;">
                            <div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-bottom:6px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#fff; font-weight:500;">
                                    <span style="width:10px; height:10px; border-radius:50%; background:var(--primary); display:inline-block;"></span> Cars
                                </span>
                                <span style="font-weight:700; color:var(--primary);">${cars} requests (${carPct}%)</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-bottom:6px;">
                                <span style="display:flex; align-items:center; gap:6px; color:var(--text-dim);">
                                    <span style="width:10px; height:10px; border-radius:50%; background:#4B5563; display:inline-block;"></span> Bikes
                                </span>
                                <span style="font-weight:700; color:#fff;">${bikes} requests (${bikePct}%)</span>
                            </div>
                        </div>
                        
                        <!-- Custom Doughnut Visualization -->
                        <div style="position:relative; width:80px; height:80px; display:flex; align-items:center; justify-content:center;">
                            <svg width="80" height="80" viewBox="0 0 36 36">
                                <circle cx="18" cy="18" r="15.915" fill="none" stroke="#4B5563" stroke-width="4"></circle>
                                <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--primary)" stroke-width="4.2"
                                        stroke-dasharray="${carPct} ${100 - carPct}" stroke-dashoffset="25"></circle>
                            </svg>
                            <div style="position:absolute; font-size:0.75rem; font-weight:800; color:#fff; text-align:center;">
                                <span>${activeRequests.length}</span><br><span style="font-size:0.5rem; color:var(--text-dim); text-transform:uppercase;">Veh</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Live Order Status Feed Ticker -->
                <div>
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="clock" style="width:16px; height:16px; color:var(--primary);"></i>
                        Live Active Order Feed Ticker
                    </h3>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${activeOrderTicker.map(r => {
                            let statusText = 'Searching for Marshal';
                            let badgeClass = 'badge-warning';
                            const st = (r.status || '').toLowerCase();
                            if (st === 'marshal_assigned') {
                                statusText = 'Marshal Assigned';
                                badgeClass = 'badge-info';
                            } else if (st === 'picked_up' || st === 'transit_to_customer') {
                                statusText = 'Vehicle in Transit';
                                badgeClass = 'badge-success';
                            }
                            return `
                                <div style="padding:12px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
                                    <div>
                                        <div style="font-size:0.85rem; font-weight:600; color:#fff;">${r.customerName || 'Customer'}</div>
                                        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">Order ID: #${r.id.substring(0,8)}</div>
                                    </div>
                                    <span class="badge ${badgeClass}" style="font-size:0.7rem;">${statusText}</span>
                                </div>
                            `;
                        }).join('')}
                        ${activeOrderTicker.length === 0 ? '<div style="padding:20px; text-align:center; color:var(--text-dim); border:1px dashed var(--border); border-radius:8px;">No active requests.</div>' : ''}
                    </div>
                </div>
            </div>
        `;
    } else {
        sectionHtml = `
            <!-- SECTION 2: MARSHAL LOGISTICS DASHBOARD -->
            <div class="card" style="margin-top:0; border: 1px solid rgba(255,255,255,0.05); background: var(--bg-surface); padding: 24px; border-radius: var(--radius-lg);">
                <h2 style="margin-top:0; color:var(--primary); font-size:1.3rem; margin-bottom:20px; display:flex; align-items:center; gap:8px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                    <i data-lucide="truck" style="width:20px; height:20px;"></i>
                    SECTION 2: Marshal Logistics Dashboard
                </h2>

                <!-- Marshal On-Duty Status -->
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <div>
                            <span style="color: var(--text-muted); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Registered Marshals</span>
                            <div style="font-size: 2.2rem; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${totalRegistered}</div>
                        </div>
                        <div style="text-align:right;">
                            <span style="color: #10B981; font-size: 0.85rem; font-weight: 700; display:flex; align-items:center; justify-content:flex-end; gap:4px;">
                                <span style="width:8px; height:8px; border-radius:50%; background:#10B981; display:inline-block; animation: pulse 1.5s infinite;"></span>
                                ${liveActiveCount} On-Duty
                            </span>
                            <span style="color: var(--text-muted); font-size: 0.7rem; display:block; margin-top:2px;">Online / Active</span>
                        </div>
                    </div>
                    <div style="height:6px; background:rgba(255,255,255,0.05); border-radius:3px; overflow:hidden;">
                        <div style="width:${totalRegistered > 0 ? (liveActiveCount / totalRegistered * 100).toFixed(0) : 0}%; height:100%; background:var(--primary);"></div>
                    </div>
                </div>

                <!-- Live Duty Stages (Horizontal Bar Chart) -->
                <div style="margin-bottom: 24px;">
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:15px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="bar-chart-2" style="width:16px; height:16px; color:var(--primary);"></i>
                        Live Marshal Duty Stages Track
                    </h3>
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <!-- Idle -->
                        <div>
                            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
                                <span style="color:var(--text-dim); font-weight:500;">Idle / Available</span>
                                <span style="font-weight:700; color:var(--primary);">${stages.idle} marshals</span>
                            </div>
                            <div style="height:8px; background:rgba(255,255,255,0.03); border-radius:4px; overflow:hidden;">
                                <div style="width:${liveActiveCount > 0 ? (stages.idle / liveActiveCount * 100).toFixed(0) : 0}%; height:100%; background:var(--primary);"></div>
                            </div>
                        </div>
                        <!-- En Route to Customer -->
                        <div>
                            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
                                <span style="color:var(--text-dim); font-weight:500;">En Route to Customer</span>
                                <span style="font-weight:700; color:#fff;">${stages.enRoute} marshals</span>
                            </div>
                            <div style="height:8px; background:rgba(255,255,255,0.03); border-radius:4px; overflow:hidden;">
                                <div style="width:${liveActiveCount > 0 ? (stages.enRoute / liveActiveCount * 100).toFixed(0) : 0}%; height:100%; background:#10B981;"></div>
                            </div>
                        </div>
                        <!-- Driving to Garage -->
                        <div>
                            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
                                <span style="color:var(--text-dim); font-weight:500;">Driving to Garage</span>
                                <span style="font-weight:700; color:#fff;">${stages.drivingToGarage} marshals</span>
                            </div>
                            <div style="height:8px; background:rgba(255,255,255,0.03); border-radius:4px; overflow:hidden;">
                                <div style="width:${liveActiveCount > 0 ? (stages.drivingToGarage / liveActiveCount * 100).toFixed(0) : 0}%; height:100%; background:#3B82F6;"></div>
                            </div>
                        </div>
                        <!-- Returning to Customer -->
                        <div>
                            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
                                <span style="color:var(--text-dim); font-weight:500;">Returning to Customer</span>
                                <span style="font-weight:700; color:#fff;">${stages.returning} marshals</span>
                            </div>
                            <div style="height:8px; background:rgba(255,255,255,0.03); border-radius:4px; overflow:hidden;">
                                <div style="width:${liveActiveCount > 0 ? (stages.returning / liveActiveCount * 100).toFixed(0) : 0}%; height:100%; background:#8B5CF6;"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Onboarding & Compliance Data -->
                <div style="margin-bottom: 24px; padding: 20px; background: rgba(255,255,255,0.01); border: 1px solid var(--border); border-radius:12px;">
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="shield-check" style="width:16px; height:16px; color:var(--primary);"></i>
                        Marshal Onboarding & Compliance Metrics
                    </h3>
                    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; text-align:center;">
                        <div style="background:rgba(16,185,129,0.03); border:1px solid rgba(16,185,129,0.1); padding:12px; border-radius:8px;">
                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">Verified (Approved)</div>
                            <div style="font-size:1.25rem; font-weight:700; color:#10B981;">${compliance.verified}</div>
                        </div>
                        <div style="background:rgba(245,158,11,0.03); border:1px solid rgba(245,158,11,0.1); padding:12px; border-radius:8px;">
                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">KYC Pending</div>
                            <div style="font-size:1.25rem; font-weight:700; color:#F59E0B;">${compliance.pending}</div>
                        </div>
                        <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:12px; border-radius:8px;">
                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">Not Started</div>
                            <div style="font-size:1.25rem; font-weight:700; color:#fff;">${compliance.unverified}</div>
                        </div>
                    </div>
                </div>

                <!-- Logistics SLAs -->
                <div>
                    <h3 style="font-size:0.95rem; color:#fff; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="award" style="width:16px; height:16px; color:var(--primary);"></i>
                        Logistics SLA Response Milestones
                    </h3>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
                        <div style="background:rgba(250,204,21,0.02); border:1px solid var(--border); padding:15px; border-radius:10px; display:flex; align-items:center; gap:12px;">
                            <div style="width:36px; height:36px; border-radius:50%; background:rgba(250,204,21,0.05); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                                <i data-lucide="navigation" style="width:18px; height:18px;"></i>
                            </div>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text-muted);">Avg. Time to Reach Customer</div>
                                <div style="font-size:1.1rem; font-weight:800; color:#fff; margin-top:2px;">${avgReachTime} mins</div>
                            </div>
                        </div>
                        <div style="background:rgba(250,204,21,0.02); border:1px solid var(--border); padding:15px; border-radius:10px; display:flex; align-items:center; gap:12px;">
                            <div style="width:36px; height:36px; border-radius:50%; background:rgba(250,204,21,0.05); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                                <i data-lucide="shield-alert" style="width:18px; height:18px;"></i>
                            </div>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text-muted);">Avg. Transit Time to Garage</div>
                                <div style="font-size:1.1rem; font-weight:800; color:#fff; margin-top:2px;">${avgTransitTime} mins</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    const html = `
        <div class="fade-in">
            <header class="page-header" style="border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 24px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <h1 class="page-title" style="display:flex; align-items:center; gap:10px;">
                        <i data-lucide="activity" style="color:var(--primary); width:28px; height:28px;"></i>
                        Live CEO Operations Command Center
                    </h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">Real-time logistics supply-demand matching & dispatch metrics</p>
                </div>
                <div style="display:flex; gap: 12px;">
                    <button class="btn btn-secondary" onclick="fetchRealtimeData().then(() => renderDashboard(document.getElementById('app')))">
                        <i data-lucide="refresh-cw"></i> Refresh Command Center
                    </button>
                </div>
            </header>
            <!-- Dashboard Tab Switcher -->
            <div class="tabs-header" style="display:flex; gap:16px; border-bottom:1px solid var(--border); margin-bottom:24px; padding-bottom:1px;">
                <button onclick="window.activeDashboardTab='demand'; renderDashboard(document.getElementById('app'))" 
                        class="tab-btn ${demandTabActive ? 'active' : ''}" 
                        style="background:none; border:none; color:${demandTabActive ? 'var(--primary)' : 'var(--text-muted)'}; font-size:1.05rem; font-weight:700; padding:12px 16px; cursor:pointer; border-bottom:3px solid ${demandTabActive ? 'var(--primary)' : 'transparent'}; transition:all 0.2s; display:inline-flex; align-items:center; gap:8px;">
                    <i data-lucide="users" style="width:18px; height:18px;"></i>
                    Customer & Demand
                </button>
                <button onclick="window.activeDashboardTab='logistics'; renderDashboard(document.getElementById('app'))" 
                        class="tab-btn ${logisticsTabActive ? 'active' : ''}" 
                        style="background:none; border:none; color:${logisticsTabActive ? 'var(--primary)' : 'var(--text-muted)'}; font-size:1.05rem; font-weight:700; padding:12px 16px; cursor:pointer; border-bottom:3px solid ${logisticsTabActive ? 'var(--primary)' : 'transparent'}; transition:all 0.2s; display:inline-flex; align-items:center; gap:8px;">
                    <i data-lucide="truck" style="width:18px; height:18px;"></i>
                    Driver Logistics
                </button>
            </div>

            <div style="display:grid; grid-template-columns: 1fr; gap: 24px;">
                ${sectionHtml}
            </div>

            </div>
        </div>
    `;
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}
function renderProviderPage(container, type) {
    if (!window.initialDataLoaded) {
        container.innerHTML = `
            <div class="fade-in" style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:300px; color:var(--text-dim);">
                <div class="loader-spin" style="width:40px; height:40px; border-width:4px; margin-bottom:16px;"></div>
                <div>Loading network data...</div>
            </div>
        `;
        return;
    }

    const tab = window.providerTabs[type] || 'active';
    const query = (window.providerSearch[type] || '').toLowerCase();

    let title = '';
    let description = '';
    let items = [];
    let counts = { active: 0, pending: 0, online: 0 };
    let registerButton = '';

    const isKycVerified = (m) => m.kycStatus === 'verified' || m.kycStatus === 'approved' || m.kycStatus === 'Approved';

    if (type === 'garages') {
        title = 'Garages';
        description = 'Manage workshop partners, service capacity, and billing tiers';
        registerButton = `
            <button class="btn btn-primary" onclick="openAddGarageModal()">
                <i data-lucide="plus"></i> Register Garage
            </button>
        `;

        const isGarageActive = (g) => g.kycstatus === 'approved' || g.kycstatus === 'verified' || g.kycstatus === 'Approved' || g.status === 'active' || g.status === 'approved';
        const allGarages = PROTOTYPE_STATE.garages || [];

        counts.active = allGarages.filter(g => isGarageActive(g)).length;
        counts.pending = allGarages.filter(g => !isGarageActive(g)).length;
        counts.online = 0;

        items = allGarages.filter(g => {
            const isActive = isGarageActive(g);
            if (tab === 'active' && !isActive) return false;
            if (tab === 'pending' && isActive) return false;
            if (tab === 'online') return false;

            return (g.name || '').toLowerCase().includes(query) ||
                   (g.owner || '').toLowerCase().includes(query) ||
                   (g.contact || '').toLowerCase().includes(query) ||
                   (g.address || '').toLowerCase().includes(query);
        });

    } else if (type === 'mechanics') {
        title = 'Mechanics';
        description = 'Garage-side technicians, service specializations, and availability';
        
        const allMechanics = (PROTOTYPE_STATE.workers || []).filter(w => w.role && w.role.toLowerCase().includes('mechanic'));
        
        counts.active = allMechanics.filter(m => isKycVerified(m) && m.status === 'active').length;
        counts.pending = allMechanics.filter(m => m.kycStatus === 'pending_approval' || m.kycStatus === 'Pending Approval' || m.kycStatus === 'pending_submission').length;
        counts.online = allMechanics.filter(m => m.is_online === 1).length;

        items = allMechanics.filter(m => {
            const isVerified = isKycVerified(m);
            const isPending = m.kycStatus === 'pending_approval' || m.kycStatus === 'Pending Approval' || m.kycStatus === 'pending_submission';
            const isActive = isVerified && m.status === 'active';
            
            if (tab === 'active' && !isActive) return false;
            if (tab === 'pending' && !isPending) return false;
            if (tab === 'online' && m.is_online !== 1) return false;

            return (m.name || '').toLowerCase().includes(query) ||
                   (m.phone || '').toLowerCase().includes(query) ||
                   (m.role || '').toLowerCase().includes(query);
        });

    } else if (type === 'drivers') {
        title = 'Drivers';
        description = 'Platform-wide logistics drivers, point-to-point transit, and field agents';
        
        const platformDrivers = (PROTOTYPE_STATE.users || []).filter(u => u.role && u.role.toLowerCase() === 'marshal' && !PROTOTYPE_STATE.workers.some(w => w.id === u.id));
        const garageDrivers = (PROTOTYPE_STATE.workers || []).filter(w => w.role && w.role.toLowerCase().includes('marshal'));

        const allDrivers = [
            ...platformDrivers.map(d => ({ ...d, type: 'Platform', kycStatus: d.kycStatus || d.kycstatus })),
            ...garageDrivers.map(d => {
                const actualGarageId = d.garageId || d.garageid;
                const garage = PROTOTYPE_STATE.garages.find(g => g.id === actualGarageId);
                return { 
                    ...d, 
                    type: 'Garage', 
                    lat: garage?.lat, 
                    lng: garage?.lng, 
                    garageName: garage?.name, 
                    kycStatus: d.kycStatus || d.kycstatus 
                };
            })
        ];

        const activeAssignmentsMap = new Set();
        (PROTOTYPE_STATE.serviceRequests || []).forEach(req => {
            if (req.workerId && !['completed', 'cancelled'].includes(req.status)) {
                activeAssignmentsMap.add(String(req.workerId));
            }
            if (req.workerid && !['completed', 'cancelled'].includes(req.status)) {
                activeAssignmentsMap.add(String(req.workerid));
            }
        });
        (PROTOTYPE_STATE.trips || []).forEach(t => {
            if (t.marshalId && !['completed', 'cancelled'].includes(t.status)) {
                activeAssignmentsMap.add(String(t.marshalId));
            }
            if (t.marshalid && !['completed', 'cancelled'].includes(t.status)) {
                activeAssignmentsMap.add(String(t.marshalid));
            }
            if (t.deliveryMarshalId && !['completed', 'cancelled'].includes(t.status)) {
                activeAssignmentsMap.add(String(t.deliveryMarshalId));
            }
            if (t.deliverymarshalid && !['completed', 'cancelled'].includes(t.status)) {
                activeAssignmentsMap.add(String(t.deliverymarshalid));
            }
        });

        const isDriverAvailable = (d) => {
            return d.is_online === 1 && !activeAssignmentsMap.has(String(d.id));
        };

        counts.active = allDrivers.filter(d => isKycVerified(d) && d.status === 'active').length;
        counts.pending = allDrivers.filter(d => d.kycStatus === 'pending_approval' || d.kycStatus === 'Pending Approval' || d.kycStatus === 'pending_submission').length;
        counts.online = allDrivers.filter(d => isDriverAvailable(d)).length;

        items = allDrivers.filter(d => {
            const isVerified = isKycVerified(d);
            const isPending = d.kycStatus === 'pending_approval' || d.kycStatus === 'Pending Approval' || d.kycStatus === 'pending_submission';
            const isActive = isVerified && d.status === 'active';

            if (tab === 'active' && !isActive) return false;
            if (tab === 'pending' && !isPending) return false;
            if (tab === 'online' && !isDriverAvailable(d)) return false;

            return (d.name || '').toLowerCase().includes(query) ||
                   (d.phone || '').toLowerCase().includes(query) ||
                   (d.garageName || '').toLowerCase().includes(query);
        });

    } else if (type === 'rental-partners') {
        title = 'Rental Partners';
        description = 'Fleet listing partners, verification documents, and rental yields';
        registerButton = `
            <button class="btn btn-secondary" onclick="router.navigate('rental-fleet')" style="display:inline-flex; align-items:center; gap:8px;">
                <i data-lucide="car"></i> View Fleet Inventory
            </button>
        `;

        const allPartners = PROTOTYPE_STATE.rentalPartners || [];

        counts.active = allPartners.filter(p => p.status === 'approved' || p.status === 'active').length;
        counts.pending = allPartners.filter(p => p.status === 'pending_approval').length;
        counts.online = 0;

        items = allPartners.filter(p => {
            const isActive = p.status === 'approved' || p.status === 'active';
            const isPending = p.status === 'pending_approval';

            if (tab === 'active' && !isActive) return false;
            if (tab === 'pending' && !isPending) return false;
            if (tab === 'online') return false;

            return (p.businessname || p.businessName || '').toLowerCase().includes(query) ||
                   (p.gstnumber || p.gstNumber || '').toLowerCase().includes(query) ||
                   (p.servicecity || p.serviceCity || '').toLowerCase().includes(query);
        });
    }

    let tableBody = '';

    if (tab === 'online' && (type === 'garages' || type === 'rental-partners')) {
        tableBody = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 40px; color: var(--text-dim);">
                    <i data-lucide="info" style="width: 32px; height: 32px; margin-bottom: 10px; opacity: 0.5;"></i>
                    <div style="font-weight: 600;">Real-time Online Tracking Not Applicable</div>
                    <div style="font-size: 0.8rem; margin-top: 4px;">Online status tracking only applies to active field technicians (Mechanics) and logistics Drivers.</div>
                </td>
            </tr>
        `;
    } else if (items.length === 0) {
        tableBody = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 60px; color: var(--text-dim);">
                    <i data-lucide="inbox" style="width: 48px; height: 48px; margin-bottom: 15px; opacity: 0.5;"></i>
                    <h3 style="margin: 0 0 5px 0; color: #fff;">No records found</h3>
                    <p style="margin: 0; font-size: 0.85rem;">No ${type} found in this view matching "${query || ''}".</p>
                </td>
            </tr>
        `;
    } else {
        tableBody = items.map(item => {
            let colName = '';
            let colContact = '';
            let colArea = '';
            let colStatus = '';
            let colActions = '';

            if (type === 'garages') {
                const isAuth = (item.serviceCenterType || item.servicecentertype) === 'authorized';
                const carBrands = (item.authorizedCarBrands || item.authorizedcarbrands || '').split(',').map(s => s.trim()).filter(Boolean);
                const bikeBrands = (item.authorizedBikeBrands || item.authorizedbikebrands || '').split(',').map(s => s.trim()).filter(Boolean);
                const allBrands = [...carBrands, ...bikeBrands];
                const brandBadge = isAuth && allBrands.length > 0 
                    ? `<span class="badge" style="font-size:0.6rem; padding: 2px 6px; background: rgba(250, 204, 21, 0.15); color: var(--primary); border: 1px solid rgba(250, 204, 21, 0.3);">🏢 Auth (${allBrands.slice(0, 2).join(', ')}${allBrands.length > 2 ? ' +' + (allBrands.length - 2) : ''})</span>`
                    : `<span class="badge badge-secondary" style="font-size:0.6rem; padding: 2px 6px;">🔧 Local</span>`;

                colName = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:36px; height:36px; border-radius:8px; background:rgba(250, 204, 21, 0.1); border:1px solid rgba(250, 204, 21, 0.2); display:flex; align-items:center; justify-content:center; color:var(--primary); font-weight:700;">
                            ${item.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <div style="font-weight:600; color:#fff;">${item.name}</div>
                            <div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:2px;">
                                <span class="badge ${item.serviceType === 'Premium' ? 'badge-success' : 'badge-primary'}" style="font-size:0.6rem; padding: 2px 6px;">${item.serviceType || 'Standard'}</span>
                                ${brandBadge}
                            </div>
                        </div>
                    </div>
                `;
                colContact = `
                    <div>
                        <div style="font-weight:500; color:#fff;">${item.owner || 'N/A'}</div>
                        <div style="font-size:0.8rem; color:var(--text-dim); margin-top:2px;">${item.contact || 'No contact'}</div>
                    </div>
                `;
                colArea = item.location || item.address || 'N/A';
                
                const isGarageActive = (g) => g.kycstatus === 'approved' || g.kycstatus === 'verified' || g.kycstatus === 'Approved';
                const isActive = isGarageActive(item);
                colStatus = `<span class="badge ${isActive ? 'badge-success' : 'badge-warning'}">${isActive ? 'ACTIVE' : 'PENDING APPROVED'}</span>`;
                colActions = `<button class="btn btn-secondary btn-sm" onclick="renderGarageDetails('${item.id}')">Manage</button>`;

            } else if (type === 'mechanics') {
                const spec = item.role ? item.role.replace('mechanic|', '') : 'General';
                colName = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:36px; height:36px; border-radius:50%; background:var(--primary-dim); border:1px solid rgba(245,158,11,0.3); display:flex; align-items:center; justify-content:center; color:var(--primary); font-weight:700;">
                            ${item.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <div style="font-weight:600; color:#fff;">${item.name}</div>
                            <span style="font-size:0.75rem; color:var(--text-dim);">${spec} Specialist</span>
                        </div>
                    </div>
                `;
                colContact = `<div style="font-weight:500; color:#fff;">${item.phone || 'N/A'}</div>`;
                
                const actualGarageId = item.garageId || item.garageid;
                const garage = PROTOTYPE_STATE.garages.find(g => g.id === actualGarageId);
                colArea = garage ? garage.name : 'Independent / Unassigned';
                
                const isOnline = item.is_online === 1;
                const isVerified = isKycVerified(item);
                
                colStatus = `
                    <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                        <span class="badge ${isVerified ? 'badge-success' : 'badge-danger'}">${isVerified ? 'VERIFIED' : 'PENDING KYC'}</span>
                        ${isOnline ? '<span class="badge badge-info" style="font-size:0.6rem;">ONLINE</span>' : ''}
                    </div>
                `;
                colActions = `<button class="btn btn-secondary btn-sm" onclick="reviewMarshalKYC('${item.id}')">Review Docs</button>`;

            } else if (type === 'drivers') {
                const driverSubtitle = item.type === 'Garage' ? `Garage Driver (${item.garageName || 'Unassigned'})` : 'Platform Logistics';
                colName = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:36px; height:36px; border-radius:50%; background:var(--primary-dim); border:1px solid rgba(245,158,11,0.3); display:flex; align-items:center; justify-content:center; color:var(--primary); font-weight:700;">
                            ${item.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <div style="font-weight:600; color:#fff;">${item.name}</div>
                            <span style="font-size:0.75rem; color:var(--text-dim);">${driverSubtitle}</span>
                        </div>
                    </div>
                `;
                colContact = `<div style="font-weight:500; color:#fff;">${item.phone || 'N/A'}</div>`;
                colArea = item.type === 'Garage' ? (item.garageName || 'Garage Unassigned') : (item.pincode ? `Pincode: ${item.pincode}` : 'Not Set');
                
                const isOnline = item.is_online === 1;
                const isVerified = isKycVerified(item);
                
                colStatus = `
                    <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                        <span class="badge ${isVerified ? 'badge-success' : 'badge-danger'}">${isVerified ? 'VERIFIED' : 'PENDING KYC'}</span>
                        ${isOnline ? '<span class="badge badge-info" style="font-size:0.6rem;">ONLINE</span>' : ''}
                    </div>
                `;
                colActions = `<button class="btn btn-secondary btn-sm" onclick="reviewMarshalKYC('${item.id}')">Review Docs</button>`;

            } else if (type === 'rental-partners') {
                colName = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:36px; height:36px; border-radius:8px; background:rgba(16, 185, 129, 0.1); border:1px solid rgba(16, 185, 129, 0.2); display:flex; align-items:center; justify-content:center; color:#10b981; font-weight:700;">
                            ${(item.businessname || item.businessName || 'P').charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <div style="font-weight:600; color:#fff;">${item.businessname || item.businessName}</div>
                            <span style="font-size:0.75rem; color:var(--text-dim);">GST: ${item.gstnumber || item.gstNumber}</span>
                        </div>
                    </div>
                `;
                colContact = `
                    <div>
                        <div style="font-weight:500; color:#fff;">${item.email || 'N/A'}</div>
                        <div style="font-size:0.8rem; color:var(--text-dim); margin-top:2px;">${item.phone || 'No phone'}</div>
                    </div>
                `;
                colArea = item.servicecity || item.serviceCity || 'N/A';
                
                const isActive = item.status === 'approved' || item.status === 'active';
                colStatus = `<span class="badge ${isActive ? 'badge-success' : 'badge-warning'}">${isActive ? 'ACTIVE' : 'PENDING APPROVAL'}</span>`;
                colActions = `<button class="btn btn-secondary btn-sm" onclick="reviewRentalPartner('${item.id}')">Review Application</button>`;
            }

            return `
                <tr style="border-bottom: 1px solid var(--border); transition: background-color 0.2s;">
                    <td style="padding:16px 20px;">${colName}</td>
                    <td style="padding:16px 20px;">${colContact}</td>
                    <td style="padding:16px 20px; color:var(--text-main); font-weight:500;">${colArea}</td>
                    <td style="padding:16px 20px;">${colStatus}</td>
                    <td style="padding:16px 20px;">${colActions}</td>
                </tr>
            `;
        }).join('');
    }

    const html = `
        <div class="fade-in">
            <header class="page-header" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <h1 class="page-title">${title}</h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">${description}</p>
                </div>
                <div style="display:flex; gap: 12px; align-items: center;">
                    ${registerButton}
                </div>
            </header>

            <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 25px; display:flex; gap: 15px; align-items:center;">
                <div style="flex:1; position:relative;">
                    <i data-lucide="search" style="position:absolute; left:15px; top:12px; color:var(--text-dim); width:18px;"></i>
                    <input type="text" id="provider-search-input" value="${query}" placeholder="Search..." 
                           style="width:100%; height:42px; background:rgba(0,0,0,0.2); border:1px solid var(--border); border-radius:8px; padding-left:45px; color:#fff; font-size:0.95rem; outline:none;"
                           onkeyup="window.providerSearch['${type}'] = this.value; if(event.key === 'Enter') renderProviderPage(document.getElementById('app'), '${type}');">
                </div>
                <button class="btn btn-secondary" onclick="renderProviderPage(document.getElementById('app'), '${type}')" style="height:42px;">Search</button>
            </div>

            <div style="padding: 8px 16px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); display:flex; gap: 10px; margin-bottom: 25px; border-radius: 12px;">
                <button class="tab-btn ${tab === 'active' ? 'active' : ''}" onclick="window.providerTabs['${type}']='active'; renderProviderPage(document.getElementById('app'), '${type}')">Active (${counts.active})</button>
                <button class="tab-btn ${tab === 'pending' ? 'active' : ''}" onclick="window.providerTabs['${type}']='pending'; renderProviderPage(document.getElementById('app'), '${type}')">Pending Approval (${counts.pending})</button>
                <button class="tab-btn ${tab === 'online' ? 'active' : ''}" onclick="window.providerTabs['${type}']='online'; renderProviderPage(document.getElementById('app'), '${type}')">Online (${counts.online})</button>
                ${type === 'rental-partners' ? `
                <button class="tab-btn ${tab === 'fleet' ? 'active' : ''}" onclick="window.providerTabs['${type}']='fleet'; renderProviderPage(document.getElementById('app'), '${type}')">Rental Fleet</button>
                ` : ''}
            </div>

            <div class="card" style="padding:0; overflow:hidden; border:1px solid var(--border); background:var(--bg-surface);">
                ${tab === 'fleet' ? `
                    <div style="padding: 20px; display: flex; justify-content: flex-end; border-bottom: 1px solid var(--border);">
                        <button class="btn btn-primary" onclick="openAddRentalVehicleModal()">
                            <i data-lucide="plus-circle"></i> Add Rental Vehicle
                        </button>
                    </div>
                    <div id="rental-fleet-loading" style="text-align: center; padding: 40px; color: var(--text-dim);">
                        <div class="loader-spin" style="margin: 0 auto 12px auto;"></div>
                        Loading rental fleet...
                    </div>
                    <div id="rental-fleet-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; padding: 20px;"></div>
                ` : `
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size:0.9rem;">
                    <thead>
                        <tr style="background:rgba(255,255,255,0.02); border-bottom: 1px solid var(--border); color:var(--text-dim); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; font-weight:700;">
                            <th style="padding:16px 20px; font-weight:700;">Name</th>
                            <th style="padding:16px 20px; font-weight:700;">Contact</th>
                            <th style="padding:16px 20px; font-weight:700;">Service Area / City</th>
                            <th style="padding:16px 20px; font-weight:700;">Status</th>
                            <th style="padding:16px 20px; font-weight:700;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableBody}
                    </tbody>
                </table>
                `}
            </div>
        </div>
    `;

    container.innerHTML = html;

    if (query) {
        setTimeout(() => {
            const input = document.getElementById('provider-search-input');
            if (input) {
                input.focus();
                const val = input.value;
                input.value = '';
                input.value = val;
            }
        }, 10);
    }

    if (window.lucide) lucide.createIcons();

    if (tab === 'fleet' && type === 'rental-partners') {
        loadFleetTab();
    }
}

async function loadFleetTab() {
    try {
        const token = localStorage.getItem('redrivo_token') || localStorage.getItem('crm_token') || localStorage.getItem('authToken') || '';
        const res = await fetch(`${API_URL}/rental-vehicles/admin/all`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const listEl = document.getElementById('rental-fleet-list');
        const loadEl = document.getElementById('rental-fleet-loading');
        if (loadEl) loadEl.style.display = 'none';
        if (!listEl) return;

        let vehicles = data.vehicles || [];
        const q = (window.providerSearch['rental-partners'] || '').toLowerCase();
        if (q) {
            vehicles = vehicles.filter(v => 
                (v.make || '').toLowerCase().includes(q) ||
                (v.model || '').toLowerCase().includes(q) ||
                (v.platenumber || v.plateNumber || '').toLowerCase().includes(q) ||
                (v.businessname || v.businessName || '').toLowerCase().includes(q)
            );
        }

        if (vehicles.length === 0) {
            listEl.innerHTML = `
                <div style="grid-column: 1 / -1; background: rgba(255,255,255,0.02); border: 1px dashed var(--border); border-radius: 12px; padding: 40px; text-align: center;">
                    <i data-lucide="car" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 12px;"></i>
                    <h3 style="color: #fff; margin-bottom: 6px;">No Rental Vehicles Found</h3>
                    <p style="color: var(--text-dim); font-size: 0.85rem; margin-bottom: 16px;">Try adjusting your search query, or add a vehicle using the button above.</p>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        listEl.innerHTML = vehicles.map(v => {
            const statusBadgeClass = v.status === 'available' ? 'badge-success' : v.status === 'booked' ? 'badge-warning' : 'badge-danger';
            return `
                <div style="background: rgba(20,22,28,0.9); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;">
                    <div style="height: 140px; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; position: relative;">
                        ${v.photos ? `<img src="${v.photos}" style="width:100%; height:100%; object-fit:cover;" />` : `
                            <i data-lucide="${v.vehicletype === 'bike' ? 'bike' : 'car'}" style="width: 56px; height: 56px; color: var(--primary); opacity: 0.8;"></i>
                        `}
                        <div style="position: absolute; top: 12px; right: 12px;" class="badge ${statusBadgeClass}">
                            ${(v.status || 'available').toUpperCase()}
                        </div>
                        <div style="position: absolute; top: 12px; left: 12px; background: rgba(0,0,0,0.7); padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; color: #fff; font-weight: 700;">
                            ${(v.vehicletype || 'CAR').toUpperCase()}
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
                        <div>
                            <h3 style="font-size: 1.1rem; color: #fff; margin: 0 0 4px 0; font-weight: 700;">${v.make} ${v.model} (${v.year || 2023})</h3>
                            <div style="font-size: 0.8rem; color: var(--primary); font-weight: 600; margin-bottom: 10px;">${v.platenumber || v.plateNumber}</div>
                            
                            <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 6px;">
                                <strong style="color: #fff;">Partner:</strong> ${v.businessname || v.businessName || 'Approved Partner'}
                            </div>
                            <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 6px;">
                                <strong style="color: #fff;">City & Pickup:</strong> ${v.city}, ${v.pickuplocationaddress || v.pickupLocationAddress}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        console.error(e);
        const listEl = document.getElementById('rental-fleet-list');
        if (listEl) listEl.innerHTML = `<div style="color: var(--danger); padding: 20px;">Failed to load rental fleet.</div>`;
    }
}


async function updateGarageStatus(garageId, status) {
    const isApprove = status === 'verified' || status === 'active';
    const action = isApprove ? 'APPROVE' : 'REJECT';
    const confirmed = await showConfirm(
        `${action} Partner?`, 
        `Are you sure you want to mark this garage as ${status.toUpperCase()}?`,
        isApprove ? 'Approve' : 'Reject',
        isApprove ? 'primary' : 'danger'
    );
    if (!confirmed) return;
    
    try {
        const res = await fetch(`${API_URL}/garages/${garageId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        
        if (!res.ok) throw new Error('Failed to update status');
        
        // Refresh global state and re-render the detail view
        await fetchRealtimeData();
        renderGarageDetails(garageId);
        
    } catch (err) {
        alert('Error updating garage status: ' + err.message);
    }
}

function renderGarageDetails(garageId) {
    CURRENT_VIEWING_GARAGE_ID = garageId;
    CURRENT_VIEWING_TAB = 'overview';
    const g = PROTOTYPE_STATE.garages.find(g => g.id === garageId);
    if (!g) return;

    const platformWorkers = PROTOTYPE_STATE.users.filter(u => u.garageId === garageId);
    const garageWorkers = PROTOTYPE_STATE.workers.filter(w => w.garageId === garageId);
    const workers = [...platformWorkers, ...garageWorkers];
    const orders = PROTOTYPE_STATE.serviceRequests.filter(sr => sr.garageId === garageId);
    const docs = (PROTOTYPE_STATE.media || []).filter(m => m.referenceId === garageId);
    const revenue = orders.reduce((sum, o) => sum + (o.totalCustomerPrice || 0), 0);
    const pendingDocs = docs.filter(d => d.status === 'pending').length;

    const container = document.getElementById('app');
    const html = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:20px; margin-bottom:30px;">
            <div style="display:flex; align-items:center; gap: 15px">
                <button onclick="router.navigate('garages')" class="btn btn-secondary" style="padding: 8px">
                    <i data-lucide="arrow-left"></i>
                </button>
                <h1 class="page-title" style="margin:0;">${g.name}</h1>
                <span class="badge ${g.status === 'active' ? 'badge-success' : 'badge-warning'}">${g.status.toUpperCase()}</span>
            </div>
            <div style="display:flex; gap: 10px; flex-wrap:wrap;">
                ${g.status === 'pending' ? `
                    <button onclick="updateGarageStatus('${g.id}', 'active')" class="btn btn-success"><i data-lucide="check-circle" style="width:18px; height:18px;"></i> Approve Garage</button>
                    <button onclick="updateGarageStatus('${g.id}', 'rejected')" class="btn btn-danger"><i data-lucide="x-circle" style="width:18px; height:18px;"></i> Reject Garage</button>
                ` : g.status === 'suspended' ? `
                    <button onclick="updateGarageStatus('${g.id}', 'active')" class="btn btn-success"><i data-lucide="play-circle" style="width:18px; height:18px;"></i> Reactivate Garage</button>
                ` : `
                    <button onclick="updateGarageStatus('${g.id}', 'suspended')" class="btn btn-danger"><i data-lucide="pause-circle" style="width:18px; height:18px;"></i> Suspend Garage</button>
                `}
            </div>
        </div>

        <div class="grid-4" style="margin-bottom: 30px">
            <div class="card" style="text-align: center">
                <div class="text-muted" style="font-size: 0.8rem; margin-bottom: 5px">Orders Received</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--primary-color)">${orders.length}</div>
            </div>
            <div class="card" style="text-align: center">
                <div class="text-muted" style="font-size: 0.8rem; margin-bottom: 5px">Workers / Drivers</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--info)">${workers.length}</div>
            </div>
            <div class="card" style="text-align: center">
                <div class="text-muted" style="font-size: 0.8rem; margin-bottom: 5px">Total Revenue</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--success)">₹${revenue.toLocaleString()}</div>
            </div>
            <div class="card" style="text-align: center">
                <div class="text-muted" style="font-size: 0.8rem; margin-bottom: 5px">Pending Verification</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: ${pendingDocs > 0 ? 'var(--warning)' : 'var(--text-muted)'}">${pendingDocs}</div>
            </div>
        </div>
        <div class="tabs" style="padding: 0; margin-bottom: 20px; background: none; border-bottom: 1px solid var(--border); overflow-x: auto; white-space: nowrap; display: flex;">
            <button class="tab-btn active" onclick="switchGarageTab('overview', '${g.id}', this)">Overview</button>
            <button class="tab-btn" onclick="switchGarageTab('orders', '${g.id}', this)">Orders</button>
            <button class="tab-btn" onclick="switchGarageTab('staff', '${g.id}', this)">Team Management</button>
            <button class="tab-btn" onclick="switchGarageTab('inventory', '${g.id}', this)">Inventory</button>
            <button class="tab-btn" onclick="switchGarageTab('rates', '${g.id}', this)">Service Rates</button>
            <button class="tab-btn" onclick="switchGarageTab('profile', '${g.id}', this)">Business Profile</button>
            <button class="tab-btn" onclick="switchGarageTab('kyc', '${g.id}', this)">Banking & KYC</button>
        </div>
        <div id="garage-tab-content"></div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
    switchGarageTab('overview', g.id);
}

function switchGarageTab(tab, garageId, btnEl) {
    CURRENT_VIEWING_TAB = tab;
    if (btnEl) {
        const parent = btnEl.parentElement;
        parent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }

    const g = PROTOTYPE_STATE.garages.find(g => g.id === garageId);
    const content = document.getElementById('garage-tab-content');
    if (!g || !content) return;

    let html = '';
    switch (tab) {
        case 'overview':
            html = `
                <div class="grid-2">
                    <div class="card">
                        <h3>Business Summary</h3>
                        <div style="margin-top: 15px; display: flex; flex-direction: column; gap: 12px;">
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Partner Since</span>
                                <span>${new Date(g.joinedDate || Date.now()).toLocaleDateString()}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Type</span>
                                <span class="badge badge-primary">${g.type || g.serviceType || 'Standard'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span style="color:var(--text-muted)">Classification</span>
                                <span class="badge ${(g.serviceCenterType || g.servicecentertype) === 'authorized' ? 'badge-warning' : 'badge-secondary'}">
                                    ${(g.serviceCenterType || g.servicecentertype) === 'authorized' ? '🏢 Authorized OEM' : '🔧 Independent / Local'}
                                </span>
                            </div>
                            ${((g.serviceCenterType || g.servicecentertype) === 'authorized' && ((g.authorizedCarBrands || g.authorizedcarbrands) || (g.authorizedBikeBrands || g.authorizedbikebrands))) ? `
                            <div style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">
                                <span style="color:var(--text-muted); font-size:0.75rem;">Authorized Brands:</span>
                                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                                    ${[...(g.authorizedCarBrands || g.authorizedcarbrands || '').split(','), ...(g.authorizedBikeBrands || g.authorizedbikebrands || '').split(',')].filter(Boolean).map(b => `<span class="badge badge-outline" style="font-size:0.65rem; border-color:var(--primary); color:var(--primary);">${b.trim()}</span>`).join('')}
                                </div>
                            </div>
                            ` : ''}
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Commission</span>
                                <span style="font-weight:700">${g.commissionRate || 10}%</span>
                            </div>
                            <hr style="border-color: rgba(255,255,255,0.05); margin: 5px 0;">
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Owner Name</span>
                                <span>${g.owner || 'N/A'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Phone</span>
                                <span>${g.contact || 'N/A'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-muted)">Email</span>
                                <span>${g.email || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="card">
                        <h3>Quick Stats</h3>
                        <div style="margin-top: 15px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div style="text-align:center; padding: 10px; background: rgba(255,255,255,0.02); border-radius: 8px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted);">Active SKUs</div>
                                <div style="font-size: 1.2rem; font-weight: 700;">${(PROTOTYPE_STATE.skus || []).filter(s => s.garageId === g.id).length}</div>
                            </div>
                            <div style="text-align:center; padding: 10px; background: rgba(255,255,255,0.02); border-radius: 8px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted);">Avg. Rating</div>
                                <div style="font-size: 1.2rem; font-weight: 700; color: var(--primary);">${g.rating || '4.5'} ⭐</div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            break;
        case 'orders':
            const orders = (PROTOTYPE_STATE.serviceRequests || []).filter(sr => sr.assignedGarageId === g.id || sr.garageId === g.id);
            html = `
                <div class="card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
                        <h3>Service Orders</h3>
                        <span class="badge badge-primary">${orders.length} Total Orders</span>
                    </div>
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Order ID</th>
                                <th>Vehicle</th>
                                <th>Status</th>
                                <th style="text-align:right">Value (₹)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${orders.length > 0 ? orders.map(o => `
                                <tr>
                                    <td style="font-weight:600; color:var(--primary)">${o.id.substring(0,8)}</td>
                                    <td>${o.vehicleModel || 'Unknown Vehicle'}</td>
                                    <td><span class="badge ${o.status === 'completed' ? 'badge-success' : 'badge-warning'}">${o.status}</span></td>
                                    <td style="text-align:right; font-weight:600;">₹${(o.totalCustomerPrice || 0).toLocaleString()}</td>
                                </tr>
                            `).join('') : '<tr><td colspan="4" style="text-align:center; padding: 30px; color:var(--text-dim);">No orders assigned to this partner yet.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            `;
            break;
        case 'staff':
            html = `
                <div class="card" id="garage-staff-container">
                    <div class="loader-spin" style="margin: 20px auto;"></div>
                </div>
            `;
            setTimeout(() => renderGarageStaffDetails(g.id), 50);
            break;
        case 'inventory':
            html = `
                <div class="card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px;">
                        <div>
                            <h3 style="margin-bottom: 4px;">Spare Parts & Inventory</h3>
                            <p style="font-size: 0.85rem; color: var(--text-dim);">Items currently stocked or active in this garage</p>
                        </div>
                        <div style="display:flex; gap: 10px;">
                            <button class="btn btn-secondary btn-sm" onclick="renderSKUCatalog(document.getElementById('app'))">Add New Parts</button>
                        </div>
                    </div>
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Item / Part</th>
                                <th>Category</th>
                                <th style="text-align:right">Price (₹)</th>
                                <th style="text-align:center">Stock Status</th>
                            </tr>
                        </thead>
                        <tbody id="garage-parts-tbody">
                            <tr><td colspan="4" style="text-align:center; padding: 20px;"><div class="loader-spin"></div></td></tr>
                        </tbody>
                    </table>
                </div>
            `;
            setTimeout(() => renderGarageInventoryOnly(g.id), 50);
            break;
        case 'rates':
            html = `
                <div class="card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px;">
                        <div>
                            <h3 style="margin-bottom: 4px;">Service Charges (Labor & Logic)</h3>
                            <p style="font-size: 0.85rem; color: var(--text-dim);">Standard service logic and labor rates for this partner</p>
                        </div>
                        <button class="btn btn-primary btn-sm" onclick="openManageRatesModal('${g.id}')">
                            <i data-lucide="settings"></i> Manage Rates
                        </button>
                    </div>

                    <div style="display:grid; grid-template-columns: 1.5fr 1.5fr 1fr 1fr; gap:15px; margin-bottom:25px; background:rgba(255,255,255,0.02); padding:20px; border-radius:12px; border:1px solid var(--border);">
                        <div>
                            <label class="label" style="font-size:0.7rem; margin-bottom:8px;">Search Item / Job</label>
                            <input type="text" id="rate-search-item" class="input" placeholder="e.g. Engine Oil" onkeyup="filterGarageRates()">
                        </div>
                        <div>
                            <label class="label" style="font-size:0.7rem; margin-bottom:8px;">Category</label>
                            <input type="text" id="rate-search-cat" class="input" placeholder="e.g. Engine" onkeyup="filterGarageRates()">
                        </div>
                        <div>
                            <label class="label" style="font-size:0.7rem; margin-bottom:8px;">Service Package</label>
                            <select id="rate-filter-package" class="select" onchange="filterGarageRates()">
                                <option value="">All Packages</option>
                                <option value="BASIC">Basic</option>
                                <option value="STANDARD">Standard</option>
                                <option value="PREMIUM">Premium</option>
                                <option value="500-POINT HEALTH REPORT">500-Point Health</option>
                            </select>
                        </div>
                        <div>
                            <label class="label" style="font-size:0.7rem; margin-bottom:8px;">Segment</label>
                            <select id="rate-filter-seg" class="select" onchange="filterGarageRates()">
                                <option value="">All Segments</option>
                                <option value="Hatchback">Hatchback</option>
                                <option value="Sedan">Sedan</option>
                                <option value="SUV">SUV</option>
                                <option value="Luxury">Luxury</option>
                                <option value="Universal">Universal</option>
                            </select>
                        </div>
                    </div>

                    <div id="garage-rates-container">
                        <div class="loader-spin" style="margin: 20px auto;"></div>
                    </div>
                </div>
            `;
            setTimeout(() => renderGarageRatesOnly(g.id), 50);
            break;
        case 'profile':
            html = `
                <div id="garage-tab-content">
                    <div style="padding: 40px; text-align: center;"><div class="loader-spin" style="margin: 0 auto 10px;"></div>Loading Business Profile...</div>
                </div>
            `;
            setTimeout(() => renderGarageProfile(garageId), 50);
            return;
        case 'kyc':
            html = `
                <div id="garage-tab-content">
                    <div style="padding: 40px; text-align: center;"><div class="loader-spin" style="margin: 0 auto 10px;"></div>Loading Banking & KYC...</div>
                </div>
            `;
            setTimeout(() => renderGarageKYCDetails(garageId), 50);
            return;
    }
    content.innerHTML = html;
    lucide.createIcons();
}

async function renderGarageInventoryOnly(garageId) {
    const partsTbody = document.getElementById('garage-parts-tbody');
    if (!partsTbody) return;
    
    // Load Parts (from local state since they are usually pre-fetched)
    const parts = (PROTOTYPE_STATE.skus || []).filter(s => s.garageId === garageId);
    if (parts.length === 0) {
        partsTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--text-dim);">No spare parts mapped to this garage.</td></tr>';
    } else {
        partsTbody.innerHTML = parts.map(s => {
            const margin = s.myPrice && s.basePrice ? ((s.myPrice - s.basePrice) / s.basePrice * 100).toFixed(1) : 0;
            return `
                <tr>
                    <td>
                        <div style="font-weight:600; color:var(--text-main);">${s.itemName}</div>
                        <div style="font-size:0.75rem; color:var(--text-dim);">${s.sparePartBrand || 'Genuine'}</div>
                    </td>
                    <td><span class="badge badge-secondary">${s.category}</span></td>
                    <td style="text-align:right;">
                        <div style="font-size:0.7rem; color:var(--text-dim); text-decoration:line-through;">₹${(s.basePrice || 0).toLocaleString()}</div>
                        <div style="font-weight:700; color:var(--primary); font-size:1rem;">₹${(s.myPrice || s.basePrice || 0).toLocaleString()}</div>
                    </td>
                    <td style="text-align:center">
                        <span class="badge ${margin > 0 ? 'badge-success' : 'badge-warning'}" style="font-size:0.65rem;">+${margin}%</span>
                    </td>
                    <td style="text-align:center">
                        <span class="chip ${s.stock > 5 ? 'chip-success' : 'chip-warning'}" style="font-size: 0.7rem;">
                            ${s.stock || 0} Units
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }
}

async function renderGarageRatesOnly(garageId) {
    const ratesContainer = document.getElementById('garage-rates-container');
    if (!ratesContainer) return;
    
    try {
        const resRates = await fetch(`${API_URL}/garages/${garageId}/rates`);
        CURRENT_GARAGE_RATES = await resRates.json();
        applyGarageRateFilters();
    } catch (err) {
        ratesContainer.innerHTML = '<div style="color:var(--danger); padding:20px;">Failed to load rates details.</div>';
    }
}

function filterGarageRates() {
    applyGarageRateFilters();
}

function applyGarageRateFilters() {
    const container = document.getElementById('garage-rates-container');
    if (!container) return;

    const searchItem = (document.getElementById('rate-search-item')?.value || '').toLowerCase();
    const searchCat = (document.getElementById('rate-search-cat')?.value || '').toLowerCase();
    const filterPkg = (document.getElementById('rate-filter-package')?.value || '');
    const filterSeg = (document.getElementById('rate-filter-seg')?.value || '');

    // 1. Initial Filtering
    let filtered = CURRENT_GARAGE_RATES.filter(r => {
        const parts = r.item.split('|');
        const cat = (parts.length > 1 ? parts[0] : 'General').toLowerCase();
        const item = (parts.length > 1 ? parts[1] : r.item).toLowerCase();

        const matchesItem = item.includes(searchItem);
        const matchesCat = cat.includes(searchCat);
        const matchesPkg = !filterPkg || cat.toUpperCase().includes(filterPkg.toUpperCase());
        const matchesSeg = !filterSeg || r.segment === filterSeg;

        return matchesItem && matchesCat && matchesPkg && matchesSeg;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-dim); border: 1px dashed var(--border); border-radius:12px; background:rgba(255,255,255,0.01);">No matching rates found.</div>';
        return;
    }

    // 2. Grouping by Item + Logic for the Grid View
    const grouped = {};
    filtered.forEach(r => {
        const parts = r.item.split('|');
        const cat = parts.length > 1 ? parts[0] : 'General';
        const item = parts.length > 1 ? parts[1] : r.item;
        const logic = r.logicType || 'Standard';
        
        const key = `${cat}|${item}|${logic}`;
        if (!grouped[key]) {
            grouped[key] = { cat, item, logic, segments: {}, warranty: { days: 0, km: 0 } };
        }
        
        grouped[key].segments[r.segment] = r.price;
        if (r.warrantyDays > grouped[key].warranty.days) grouped[key].warranty.days = r.warrantyDays;
        if (r.warrantyKM > grouped[key].warranty.km) grouped[key].warranty.km = r.warrantyKM;
    });

    // 3. Rendering
    const SEGMENTS = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];
    
    let html = `
        <table class="data-table" style="width:100%; border-collapse: collapse;">
            <thead>
                <tr>
                    <th style="text-align:left;">Service Item & Category</th>
                    <th style="text-align:center; width:80px;">Logic</th>
                    ${SEGMENTS.map(s => `<th style="text-align:center; min-width:80px;">${s.toUpperCase()}</th>`).join('')}
                    <th style="text-align:center; width:100px;">Warranty</th>
                </tr>
            </thead>
            <tbody>
                ${Object.values(grouped).map(g => `
                    <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
                        <td style="padding: 15px 10px;">
                            <div style="font-weight:600; color:var(--text-main); font-size:0.95rem;">${g.item}</div>
                            <div style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">${g.cat}</div>
                        </td>
                        <td style="text-align:center;">
                            <span class="badge ${g.logic === 'Labor' ? 'badge-info' : 'badge-primary'}" style="font-size:0.65rem;">${g.logic}</span>
                        </td>
                        ${SEGMENTS.map(s => `
                            <td style="text-align:center; font-weight:700; color:var(--primary); font-size:1rem;">
                                ${g.segments[s] !== undefined ? `₹${g.segments[s].toLocaleString()}` : '<span style="color:var(--text-dim); font-weight:400; font-size:0.8rem;">-</span>'}
                            </td>
                        `).join('')}
                        <td style="text-align:center;">
                            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:4px 8px; border-radius:6px; display:inline-block; font-size:0.75rem; color:var(--text-dim);">
                                <i data-lucide="shield-check" style="width:12px; height:12px; color:var(--primary); margin-right:4px; vertical-align:middle;"></i>
                                ${g.warranty.days}D / ${g.warranty.km}K
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = html;
    lucide.createIcons();
}

async function renderGarageProfile(garageId) {
    const container = document.getElementById('garage-tab-content');
    if (!container) return;

    try {
        const res = await fetch(`${API_URL}/garages/${garageId}`);
        const g = await res.json();

        container.innerHTML = `
            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px;">
                    <h3>Partner Business Profile</h3>
                    <div style="display:flex; gap:8px;">
                        <span class="badge badge-info">${g.businessType || 'Individual'}</span>
                        <span class="badge badge-primary">${g.serviceType || 'Car'}</span>
                    </div>
                </div>

                <div class="grid-2" style="gap: 24px;">
                    <div class="form-group">
                        <label class="label">Legal Business Name</label>
                        <input type="text" class="input" value="${g.name || ''}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">Primary Owner / Director</label>
                        <input type="text" class="input" value="${g.ownerName || g.owner || '-'}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">GST Number (if applicable)</label>
                        <input type="text" class="input" value="${g.gstNumber || 'Not provided'}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">Primary Phone (Login)</label>
                        <input type="text" class="input" value="${g.phone || '-'}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">Alternative Phone</label>
                        <input type="text" class="input" value="${g.altPhone || 'None'}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">Email Address</label>
                        <input type="text" class="input" value="${g.email || '-'}" readonly>
                    </div>
                    
                    <div class="form-group" style="grid-column: span 2;">
                        <label class="label">Registered Office / Operational Address</label>
                        <textarea class="input" style="height: 100px;" readonly>${g.address || '-'}</textarea>
                    </div>

                    <div class="form-group">
                        <label class="label">GPS Latitude</label>
                        <input type="text" class="input" value="${g.lat || '-'}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="label">GPS Longitude</label>
                        <input type="text" class="input" value="${g.lng || '-'}" readonly>
                    </div>

                    <div class="form-group" style="grid-column: span 2;">
                        <label class="label">Google Maps Link</label>
                        <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:8px; border:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-size:0.85rem; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%;">${g.gmapLink || 'No link generated'}</span>
                            ${g.gmapLink ? `<a href="${g.gmapLink}" target="_blank" class="btn btn-secondary btn-sm"><i data-lucide="external-link"></i> View Map</a>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
        lucide.createIcons();
    } catch (err) {
        container.innerHTML = '<div style="color:var(--danger); padding:20px;">Failed to load profile details.</div>';
    }
}

async function renderGarageKYCDetails(garageId) {
    const container = document.getElementById('garage-tab-content');
    if (!container) return;

    try {
        // Fetch fresh garage data for bank details
        const resG = await fetch(`${API_URL}/garages/${garageId}`);
        const g = await resG.json();

        // Fetch owners
        const resOwners = await fetch(`${API_URL}/garages/${garageId}/owners`);
        const owners = await resOwners.json();
        
        // Fetch media fresh
        const resMedia = await fetch(`${API_URL}/media?referenceId=${garageId}`);
        const docs = await resMedia.json();

        let html = `
            <div class="card" style="margin-bottom: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
                    <h3>Garage Banking Details</h3>
                    ${g.bankVerified ? '<span class="badge badge-success"><i data-lucide="check-circle" style="width:12px; height:12px; margin-right:4px; display:inline-block; vertical-align:text-bottom;"></i> VERIFIED</span>' : '<span class="badge badge-warning">PENDING VERIFICATION</span>'}
                </div>
                <div class="grid-4" style="gap: 15px;">
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:8px; border:1px solid var(--border);">
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">Bank Name</div>
                        <div style="font-weight:600; font-size:1rem;">${g.bankName || '-'}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:8px; border:1px solid var(--border);">
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">Account Name</div>
                        <div style="font-weight:600; font-size:1rem;">${g.bankAccountName || '-'}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:8px; border:1px solid var(--border);">
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">Account Number</div>
                        <div style="font-weight:600; font-size:1rem; letter-spacing:1px;">${g.bankAccountNumber || '-'}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:8px; border:1px solid var(--border);">
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">IFSC Code</div>
                        <div style="font-weight:600; font-size:1rem; letter-spacing:1px;">${g.bankIFSC || '-'}</div>
                    </div>
                </div>
            </div>
            
            <h3 style="margin-bottom: 16px;">Owner KYC Profiles</h3>
        `;

        if (owners.length === 0) {
            html += '<div class="card" style="text-align:center; padding: 40px; color: var(--text-dim);">No owners registered for this garage yet.</div>';
        }

        owners.forEach(owner => {
            html += `
                <div class="card" style="margin-bottom: 24px; border-left: 4px solid var(--primary);">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 20px;">
                        <div>
                            <h3 style="margin:0 0 4px 0; display:flex; align-items:center; gap:8px;">
                                ${owner.name || 'Owner'} 
                            </h3>
                            <div style="color:var(--text-muted); font-size:0.85rem;">Phone: ${owner.phone || '-'} &nbsp;|&nbsp; Email: ${owner.email || '-'}</div>
                        </div>
                    </div>
                    
                    <div class="grid-2" style="gap: 20px;">
                        <!-- PAN Card Block -->
                        <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:8px; display:flex; flex-direction:column; overflow:hidden;">
                            <div style="padding: 12px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2);">
                                <div>
                                    <span style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; display:block;">PAN Number</span>
                                    <span style="font-weight:700; letter-spacing:1px;">${owner.pan || 'Not provided'}</span>
                                </div>
                                ${owner.panVerified ? '<span class="badge badge-success">Verified</span>' : '<span class="badge badge-warning">Pending</span>'}
                            </div>
                            <div style="padding:16px; display:flex; justify-content:center; align-items:center; background:#000; min-height: 180px;">
                                ${owner.panPath ? 
                                    `<a href="${BASE_URL}/${owner.panPath}" target="_blank" title="Click to view full size"><img src="${BASE_URL}/${owner.panPath}" style="max-width:100%; max-height:200px; object-fit:contain; border-radius:4px;" /></a>` 
                                    : `<div style="color:var(--text-dim); font-size:0.85rem; display:flex; flex-direction:column; align-items:center; gap:8px;"><i data-lucide="image-off" style="width:32px; height:32px; opacity:0.5;"></i> No PAN Document Uploaded</div>`
                                }
                            </div>
                        </div>

                        <!-- Aadhaar Card Block -->
                        <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:8px; display:flex; flex-direction:column; overflow:hidden;">
                            <div style="padding: 12px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2);">
                                <div>
                                    <span style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; display:block;">Aadhaar Number</span>
                                    <span style="font-weight:700; letter-spacing:1px;">${owner.aadhaar || 'Not provided'}</span>
                                </div>
                                ${owner.aadhaarVerified ? '<span class="badge badge-success">Verified</span>' : '<span class="badge badge-warning">Pending</span>'}
                            </div>
                            <div style="padding:16px; display:flex; justify-content:center; align-items:center; background:#000; min-height: 180px;">
                                ${owner.aadhaarPath ? 
                                    `<a href="${BASE_URL}/${owner.aadhaarPath}" target="_blank" title="Click to view full size"><img src="${BASE_URL}/${owner.aadhaarPath}" style="max-width:100%; max-height:200px; object-fit:contain; border-radius:4px;" /></a>` 
                                    : `<div style="color:var(--text-dim); font-size:0.85rem; display:flex; flex-direction:column; align-items:center; gap:8px;"><i data-lucide="image-off" style="width:32px; height:32px; opacity:0.5;"></i> No Aadhaar Document Uploaded</div>`
                                }
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        // Other Garage Documents (Professional Evidence Card View)
        html += `
            <h3 style="margin-top: 32px; margin-bottom: 16px;">Evidence & Documents</h3>
            <div class="grid-2" style="gap: 20px;">
                ${[
                    { id: 'shop_act', label: 'Shop Act / Business License', icon: 'file-text' },
                    { id: 'pan', label: 'PAN Card Document', icon: 'credit-card' },
                    { id: 'gov_id', label: 'Aadhaar Card Document', icon: 'contact' },
                    { id: 'gst_cert', label: 'GST Registration Certificate', icon: 'file-check' }
                ].map(item => {
                    const doc = docs.find(m => m.docType === item.id);
                    return `
                        <div class="card" style="margin:0; display:flex; align-items:center; justify-content:space-between; padding:20px; background:rgba(255,255,255,0.02);">
                            <div style="display:flex; align-items:center; gap:16px;">
                                <div style="width:48px; height:48px; background:rgba(255,255,255,0.05); border-radius:8px; display:flex; align-items:center; justify-content:center;">
                                    <i data-lucide="${item.icon}" style="color:var(--primary);"></i>
                                </div>
                                <div>
                                    <div style="font-weight:700; font-size:0.95rem;">${item.label}</div>
                                    <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                                        ${doc ? `Uploaded: ${doc.filePath.split('/').pop()}` : 'Missing or Not Uploaded'}
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; align-items:center; gap:12px;">
                                <span class="badge ${doc ? 'badge-success' : 'badge-danger'}" style="font-size:0.6rem;">${doc ? 'UPLOADED' : 'MISSING'}</span>
                                ${doc ? `
                                    <a href="${BASE_URL}/${doc.filePath}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 6px 12px; font-size:0.8rem; background:#fff; color:#000; border:none;">
                                        <i data-lucide="eye" style="width:14px; height:14px;"></i> View
                                    </a>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        container.innerHTML = html;
        lucide.createIcons();

    } catch (e) {
        console.error('KYC load error:', e);
        container.innerHTML = '<div style="color:var(--danger); padding:20px;">Failed to load KYC details from server.</div>';
    }
}

async function renderGarageStaffDetails(garageId) {
    const container = document.getElementById('garage-staff-container');
    if (!container) return;
    try {
        const res = await fetch(`${API_URL}/garages/${garageId}/workers`);
        const staff = await res.json();
        
        const count = staff.length;
        const mechanics = staff.filter(u => u.role?.toLowerCase().includes('mechanic')).length;

        let html = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px;">
                <div>
                    <h3 style="margin-bottom: 4px;">Current Team</h3>
                    <p style="font-size: 0.85rem; color: var(--text-dim);">Manage your garage staff, mechanics, and supervisors.</p>
                </div>
                <div style="display:flex; align-items:center; gap:12px;">
                    <span class="badge badge-secondary" style="padding: 6px 12px; font-weight:700;">${count} Members</span>
                    <button class="btn btn-primary btn-sm" style="background:var(--primary); color:#000; font-weight:700;">
                        <i data-lucide="user-plus" style="width:14px; height:14px; margin-right:6px;"></i> Add Team Member
                    </button>
                </div>
            </div>

            <div style="display:flex; gap:12px; margin-bottom: 25px;">
                <div style="background: rgba(250, 204, 21, 0.1); padding: 4px 12px; border-radius: 6px; border: 1px solid var(--primary); font-size: 0.7rem; font-weight: 700; color: var(--primary); text-transform: uppercase; letter-spacing: 0.5px;">
                    ALL CATEGORIES: ${count}
                </div>
                <div style="background: rgba(255, 255, 255, 0.05); padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); font-size: 0.7rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px;">
                    MECHANICS: ${mechanics}
                </div>
            </div>

            <table class="data-table" style="width:100%; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--border);">
                        <th style="text-align:left; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">NAME</th>
                        <th style="text-align:left; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">PHONE</th>
                        <th style="text-align:left; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">ROLE</th>
                        <th style="text-align:left; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">PORTAL</th>
                        <th style="text-align:center; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">STATUS</th>
                        <th style="text-align:center; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">JOINED ON</th>
                        <th style="text-align:right; padding:12px 10px; font-size:0.75rem; color:var(--text-muted); letter-spacing:1px;">ACTION</th>
                    </tr>
                </thead>
                <tbody>
                    ${staff.map(u => {
                        const role = (u.role || 'Member').toUpperCase();
                        const portal = role.includes('MECHANIC') ? 'MECHANIC PORTAL' : 
                                       role.includes('MARSHAL') ? 'MARSHAL APP' : 
                                       role.includes('SUPERVISOR') ? 'SUPERVISOR VIEW' : 'PARTNER PORTAL';
                        const portalClass = role.includes('MECHANIC') ? 'badge-warning' : 
                                           role.includes('MARSHAL') ? 'badge-info' : 
                                           role.includes('SUPERVISOR') ? 'badge-success' : 'badge-primary';
                        
                        return `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
                            <td style="padding: 15px 10px;">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <div style="width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.05); display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--primary); font-size:0.8rem;">
                                        ${u.name.charAt(0).toUpperCase()}
                                    </div>
                                    <div style="font-weight:600; color:var(--text-main); font-size:0.95rem;">${u.name}</div>
                                </div>
                            </td>
                            <td style="color:var(--text-dim); font-size:0.9rem;">${u.phone || '-'}</td>
                            <td style="font-size:0.75rem; color:var(--text-muted); font-weight:600; letter-spacing:0.5px;">${role}</td>
                            <td>
                                <span class="badge ${portalClass}" style="font-size:0.65rem; padding:4px 10px; letter-spacing:0.5px;">${portal}</span>
                            </td>
                            <td style="text-align:center;">
                                <span style="color:var(--success); font-weight:700; font-size:0.7rem; letter-spacing:1px;">ACTIVE</span>
                            </td>
                            <td style="text-align:center; color:var(--text-dim); font-size:0.85rem;">
                                ${u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A'}
                            </td>
                            <td style="text-align:right;">
                                <div style="display:flex; gap:12px; justify-content:flex-end;">
                                    <button class="btn-text" style="color:var(--primary); font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Edit</button>
                                    <button class="btn-text" style="color:var(--danger); font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Remove</button>
                                </div>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        `;

        container.innerHTML = html;
        lucide.createIcons();
    } catch(e) {
        container.innerHTML = '<div style="color:var(--danger); padding:20px;">Failed to load staff details from server.</div>';
    }
}


function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function refreshActiveUserView() {
    const cur = router.currentPage;
    if (cur === 'drivers') renderProviderPage(document.getElementById('app'), 'drivers');
    else if (cur === 'mechanics') renderProviderPage(document.getElementById('app'), 'mechanics');
    else if (cur === 'garages') renderProviderPage(document.getElementById('app'), 'garages');
    else if (cur === 'rental-partners') renderProviderPage(document.getElementById('app'), 'rental-partners');
    else if (cur === 'approvals') renderApprovalsCentral(document.getElementById('app'));
}

function renderApprovalsCentral(container) {
    if (!window.initialDataLoaded) {
        container.innerHTML = `
            <div class="fade-in" style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:300px; color:var(--text-dim);">
                <div class="loader-spin" style="width:40px; height:40px; border-width:4px; margin-bottom:16px;"></div>
                <div>Loading Approvals Central...</div>
            </div>
        `;
        return;
    }

    const isGarageActive = (g) => g.kycstatus === 'approved' || g.kycstatus === 'verified' || g.kycstatus === 'Approved';
    const isKycVerified = (m) => m.kycStatus === 'verified' || m.kycStatus === 'approved' || m.kycStatus === 'Approved';
    
    const pendingGarages = (PROTOTYPE_STATE.garages || []).filter(g => !isGarageActive(g)).length;
    const pendingMechanics = (PROTOTYPE_STATE.workers || []).filter(w => w.role && w.role.toLowerCase().includes('mechanic') && (w.kycStatus === 'pending_approval' || w.kycStatus === 'Pending Approval' || w.kycStatus === 'pending_submission')).length;
    const pendingDrivers = (PROTOTYPE_STATE.users || []).filter(u => u.role && u.role.toLowerCase() === 'marshal' && (u.kycStatus === 'pending_approval' || u.kycStatus === 'Pending Approval' || u.kycStatus === 'pending_submission')).length;
    const pendingRentalPartners = (PROTOTYPE_STATE.rentalPartners || []).filter(p => p.status === 'pending_approval').length;

    const totalPending = pendingGarages + pendingMechanics + pendingDrivers + pendingRentalPartners;

    const html = `
        <div class="fade-in">
            <header class="page-header">
                <div>
                    <h1 class="page-title">Approvals Central</h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">Unified verification control tower for garages, technicians, drivers, and fleet partners &bull; <strong>${totalPending} Total Pending</strong></p>
                </div>
            </header>

            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:20px; margin-bottom: 30px;">
                <!-- Garages Card -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border:1px solid var(--border); padding:20px;">
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div style="width:40px; height:40px; border-radius:8px; background:rgba(250, 204, 21, 0.1); border:1px solid rgba(250, 204, 21, 0.2); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                                <i data-lucide="warehouse"></i>
                            </div>
                            <span class="badge ${pendingGarages > 0 ? 'badge-warning' : 'badge-success'}">${pendingGarages} Pending</span>
                        </div>
                        <h3 style="margin: 15px 0 5px 0; color:#fff; font-size:1.15rem;">Garages</h3>
                        <p style="color:var(--text-dim); font-size:0.85rem; margin:0 0 20px 0;">Workshop registrations awaiting business KYC and verification</p>
                    </div>
                    <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="window.providerTabs.garages='pending'; router.navigate('garages')">
                        Go to Garages <i data-lucide="arrow-right" style="width:14px; margin-left:4px;"></i>
                    </button>
                </div>

                <!-- Mechanics Card -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border:1px solid var(--border); padding:20px;">
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div style="width:40px; height:40px; border-radius:8px; background:rgba(245, 158, 11, 0.1); border:1px solid rgba(245, 158, 11, 0.2); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                                <i data-lucide="wrench"></i>
                            </div>
                            <span class="badge ${pendingMechanics > 0 ? 'badge-warning' : 'badge-success'}">${pendingMechanics} Pending</span>
                        </div>
                        <h3 style="margin: 15px 0 5px 0; color:#fff; font-size:1.15rem;">Mechanics</h3>
                        <p style="color:var(--text-dim); font-size:0.85rem; margin:0 0 20px 0;">Garage technician profiles and specializations awaiting admin approval</p>
                    </div>
                    <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="window.providerTabs.mechanics='pending'; router.navigate('mechanics')">
                        Go to Mechanics <i data-lucide="arrow-right" style="width:14px; margin-left:4px;"></i>
                    </button>
                </div>

                <!-- Drivers Card -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border:1px solid var(--border); padding:20px;">
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div style="width:40px; height:40px; border-radius:8px; background:rgba(59, 130, 246, 0.1); border:1px solid rgba(59, 130, 246, 0.2); display:flex; align-items:center; justify-content:center; color:#3b82f6;">
                                <i data-lucide="shield"></i>
                            </div>
                            <span class="badge ${pendingDrivers > 0 ? 'badge-warning' : 'badge-success'}">${pendingDrivers} Pending</span>
                        </div>
                        <h3 style="margin: 15px 0 5px 0; color:#fff; font-size:1.15rem;">Drivers</h3>
                        <p style="color:var(--text-dim); font-size:0.85rem; margin:0 0 20px 0;">Platform logistics drivers and field agent driver license verification</p>
                    </div>
                    <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="window.providerTabs.drivers='pending'; router.navigate('drivers')">
                        Go to Drivers <i data-lucide="arrow-right" style="width:14px; margin-left:4px;"></i>
                    </button>
                </div>

                <!-- Rental Partners Card -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border:1px solid var(--border); padding:20px;">
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div style="width:40px; height:40px; border-radius:8px; background:rgba(16, 185, 129, 0.1); border:1px solid rgba(16, 185, 129, 0.2); display:flex; align-items:center; justify-content:center; color:#10b981;">
                                <i data-lucide="key"></i>
                            </div>
                            <span class="badge ${pendingRentalPartners > 0 ? 'badge-warning' : 'badge-success'}">${pendingRentalPartners} Pending</span>
                        </div>
                        <h3 style="margin: 15px 0 5px 0; color:#fff; font-size:1.15rem;">Rental Partners</h3>
                        <p style="color:var(--text-dim); font-size:0.85rem; margin:0 0 20px 0;">Fleet operator partners and business incorporation document checks</p>
                    </div>
                    <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="window.providerTabs['rental-partners']='pending'; router.navigate('rental-partners')">
                        Go to Rental Partners <i data-lucide="arrow-right" style="width:14px; margin-left:4px;"></i>
                    </button>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

async function reviewRentalPartner(partnerId) {
    console.log('Reviewing Rental Partner ID:', partnerId);
    let p = (PROTOTYPE_STATE.rentalPartners || []).find(x => String(x.id) === String(partnerId));
    
    if (!p) {
        try {
            const res = await fetch(`${API_URL}/rental-partners/${partnerId}`);
            if (res.ok) {
                const data = await res.json();
                p = data.partner;
            }
        } catch (e) {
            console.error('Failed to fetch rental partner details:', e);
        }
    }
    
    if (!p) {
        await showAlert('Error', 'Rental Partner application details not found.', 'Close', 'error');
        return;
    }

    const incCertUrl = getAttachmentUrl(p.incorporationcerturl || p.incorporationCertUrl);
    const panCardUrl = getAttachmentUrl(p.pancardurl || p.panCardUrl);
    const isIncPdf = incCertUrl.toLowerCase().endsWith('.pdf') || incCertUrl.includes('pdf');
    const isPanPdf = panCardUrl.toLowerCase().endsWith('.pdf') || panCardUrl.includes('pdf');

    // Fetch GST Certificate details if available
    const gstCertUrl = getAttachmentUrl(p.gstcerturl || p.gstCertUrl);
    const isGstPdf = gstCertUrl.toLowerCase().endsWith('.pdf') || gstCertUrl.includes('pdf');

    const modalHtml = `
        <div class="modal-overlay open" id="modal-review-partner" style="display:flex;">
            <div class="modal-content" style="max-width: 680px; width: 92%; max-height: 90vh; display: flex; flex-direction: column; background:#121212; border:1px solid #333;">
                <header style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #333; padding: 20px 20px 15px 20px;">
                    <div>
                        <h2 style="margin:0; font-size:1.3rem; color:#fff;">Review Rental Partner: ${p.businessname || p.businessName}</h2>
                        <div style="font-size:0.8rem; color:var(--text-dim); margin-top:4px;">
                            Applicant: <b>${p.applicantname || p.applicantName || 'N/A'}</b> &bull; Phone: ${p.applicantphone || p.applicantPhone || 'N/A'}
                        </div>
                    </div>
                    <button onclick="closeModal('modal-review-partner')" class="btn btn-secondary" style="padding:4px 10px;">✕</button>
                </header>

                <div class="modal-body" style="display:flex; flex-direction:column; gap:20px; overflow-y:auto; flex:1; padding: 20px;">
                    <!-- Business Overview -->
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--primary); margin-bottom:12px;">Business & Legal Profile</h3>
                        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; font-size:0.85rem;">
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">BUSINESS NAME</span>
                                <strong style="color:#fff;">${p.businessname || p.businessName}</strong>
                            </div>
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">INCORPORATION DATE</span>
                                <strong style="color:#fff;">${p.incorporationdate || p.incorporationDate || 'N/A'}</strong>
                            </div>
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">GST NUMBER</span>
                                <strong style="color:var(--primary);">${p.gstnumber || p.gstNumber}</strong>
                            </div>
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">BUSINESS PAN</span>
                                <strong style="color:#fff;">${p.pannumber || p.panNumber}</strong>
                            </div>
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">SERVICE CITY</span>
                                <strong style="color:#fff;">${p.servicecity || p.serviceCity}</strong>
                            </div>
                        </div>
                    </div>

                    <!-- Addresses -->
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--info); margin-bottom:12px;">Registered & Service Addresses</h3>
                        <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">SERVICE ADDRESS</span>
                                <span style="color:#fff;">${p.serviceaddress || p.serviceAddress}</span>
                            </div>
                            <div>
                                <span style="color:var(--text-dim); display:block; font-size:0.75rem;">REGISTERED BUSINESS ADDRESS</span>
                                <span style="color:#fff;">${p.registeredaddress || p.registeredAddress}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Verification Documents -->
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--primary); margin-bottom:12px;">Uploaded Verification Documents</h3>
                        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px;">
                            <!-- Incorporation Certificate -->
                            <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; border:1px solid var(--border);">
                                <div style="font-size:0.75rem; color:var(--text-dim); font-weight:700; margin-bottom:8px;">INCORPORATION CERTIFICATE</div>
                                ${incCertUrl ? `
                                    <a href="${incCertUrl}" target="_blank" class="btn btn-secondary btn-sm" style="width:100%; padding:8px; display:inline-flex; align-items:center; justify-content:center; gap:6px; font-size:0.8rem; text-decoration:none;">
                                        <i data-lucide="${isIncPdf ? 'file-text' : 'image'}" style="width:16px;"></i> View Certificate ${isIncPdf ? '(PDF)' : ''}
                                    </a>
                                ` : '<div class="badge badge-danger">Not Uploaded</div>'}
                            </div>

                            <!-- Business PAN Card -->
                            <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; border:1px solid var(--border);">
                                <div style="font-size:0.75rem; color:var(--text-dim); font-weight:700; margin-bottom:8px;">BUSINESS PAN CARD</div>
                                ${panCardUrl ? `
                                    <a href="${panCardUrl}" target="_blank" class="btn btn-secondary btn-sm" style="width:100%; padding:8px; display:inline-flex; align-items:center; justify-content:center; gap:6px; font-size:0.8rem; text-decoration:none;">
                                        <i data-lucide="${isPanPdf ? 'file-text' : 'image'}" style="width:16px;"></i> View PAN Document ${isPanPdf ? '(PDF)' : ''}
                                    </a>
                                ` : '<div class="badge badge-danger">Not Uploaded</div>'}
                            </div>

                            <!-- GST Certificate -->
                            <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; border:1px solid var(--border);">
                                <div style="font-size:0.75rem; color:var(--text-dim); font-weight:700; margin-bottom:8px;">GST CERTIFICATE</div>
                                ${gstCertUrl ? `
                                    <a href="${gstCertUrl}" target="_blank" class="btn btn-secondary btn-sm" style="width:100%; padding:8px; display:inline-flex; align-items:center; justify-content:center; gap:6px; font-size:0.8rem; text-decoration:none;">
                                        <i data-lucide="${isGstPdf ? 'file-text' : 'image'}" style="width:16px;"></i> View GST Certificate ${isGstPdf ? '(PDF)' : ''}
                                    </a>
                                ` : '<div class="badge badge-danger">Not Uploaded</div>'}
                            </div>
                        </div>
                    </div>

                    <!-- Actions -->
                    <div style="display:flex; gap:12px; margin-top:10px;">
                        <button class="btn btn-danger" style="flex:1;" onclick="rejectRentalPartner('${p.id}')">
                            <i data-lucide="x-circle"></i> Reject Application
                        </button>
                        <button class="btn btn-success" style="flex:1.5;" onclick="approveRentalPartner('${p.id}')">
                            <i data-lucide="check-circle"></i> Approve Rental Partner
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('modal-container').innerHTML = modalHtml;
    if (window.lucide) lucide.createIcons();
}

async function approveRentalPartner(partnerId) {
    const confirmed = await showConfirm(
        'Approve Rental Partner?',
        'Are you sure you want to approve this Rental Partner application? They will be onboarded to list rental vehicles.',
        'Approve Partner'
    );
    if (!confirmed) return;

    try {
        const res = await fetch(`${API_URL}/rental-partners/${partnerId}/approve`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvedBy: 'u_admin' })
        });

        if (!res.ok) throw new Error('Approval request failed');

        await showAlert('Success', 'Rental Partner Approved Successfully!', 'Done', 'success');
        closeModal('modal-review-partner');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function rejectRentalPartner(partnerId) {
    const reason = await window.customShowPrompt('Please specify reason for rejecting this Rental Partner application:');
    if (reason === null) return;

    try {
        const res = await fetch(`${API_URL}/rental-partners/${partnerId}/reject`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });

        if (!res.ok) throw new Error('Rejection request failed');

        await showAlert('Success', 'Rental Partner Application Rejected.', 'Done', 'success');
        closeModal('modal-review-partner');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

// --- RENTAL FLEET MANAGEMENT ---
async function renderRentalFleet(container) {
    container.innerHTML = `
        <div style="padding: 20px; max-width: 1200px; margin: 0 auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                <div>
                    <h1 style="font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0;">Rental Fleet Management</h1>
                    <p style="color: var(--text-dim); margin-top: 4px; font-size: 0.85rem;">Manage vehicles listed under approved Rental Partners</p>
                </div>
                <button class="btn btn-primary" onclick="openAddRentalVehicleModal()">
                    <i data-lucide="plus-circle"></i> Add Rental Vehicle
                </button>
            </div>

            <div id="rental-fleet-loading" style="text-align: center; padding: 40px; color: var(--text-dim);">
                <div class="loader-spin" style="margin: 0 auto 12px auto;"></div>
                Loading rental fleet...
            </div>

            <div id="rental-fleet-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;"></div>
        </div>
    `;
    if (window.lucide) lucide.createIcons();

    try {
        const token = localStorage.getItem('crm_token') || localStorage.getItem('authToken') || '';
        const res = await fetch(`${API_URL}/rental-vehicles/admin/all`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const listEl = document.getElementById('rental-fleet-list');
        const loadEl = document.getElementById('rental-fleet-loading');
        if (loadEl) loadEl.style.display = 'none';

        if (!data.vehicles || data.vehicles.length === 0) {
            listEl.innerHTML = `
                <div style="grid-column: 1 / -1; background: rgba(255,255,255,0.02); border: 1px dashed var(--border); border-radius: 12px; padding: 40px; text-align: center;">
                    <i data-lucide="car" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 12px;"></i>
                    <h3 style="color: #fff; margin-bottom: 6px;">No Rental Vehicles Listed Yet</h3>
                    <p style="color: var(--text-dim); font-size: 0.85rem; margin-bottom: 16px;">Click 'Add Rental Vehicle' to onboard a vehicle under an approved partner.</p>
                    <button class="btn btn-primary" onclick="openAddRentalVehicleModal()">
                        <i data-lucide="plus"></i> Add First Vehicle
                    </button>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        listEl.innerHTML = data.vehicles.map(v => {
            const statusBadgeClass = v.status === 'available' ? 'badge-success' : v.status === 'booked' ? 'badge-warning' : 'badge-danger';
            return `
                <div style="background: rgba(20,22,28,0.9); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;">
                    <div style="height: 140px; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; position: relative;">
                        ${v.photos ? `<img src="${v.photos}" style="width:100%; height:100%; object-fit:cover;" />` : `
                            <i data-lucide="${v.vehicletype === 'bike' ? 'bike' : 'car'}" style="width: 56px; height: 56px; color: var(--primary); opacity: 0.8;"></i>
                        `}
                        <div style="position: absolute; top: 12px; right: 12px;" class="badge ${statusBadgeClass}">
                            ${(v.status || 'available').toUpperCase()}
                        </div>
                        <div style="position: absolute; top: 12px; left: 12px; background: rgba(0,0,0,0.7); padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; color: #fff; font-weight: 700;">
                            ${(v.vehicletype || 'CAR').toUpperCase()}
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
                        <div>
                            <h3 style="font-size: 1.1rem; color: #fff; margin: 0 0 4px 0; font-weight: 700;">${v.make} ${v.model} (${v.year || 2023})</h3>
                            <div style="font-size: 0.8rem; color: var(--primary); font-weight: 600; margin-bottom: 10px;">${v.platenumber || v.plateNumber}</div>
                            
                            <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 6px;">
                                <strong style="color: #fff;">Partner:</strong> ${v.businessname || v.businessName || 'Approved Partner'}
                            </div>
                            <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 6px;">
                                <strong style="color: #fff;">City & Pickup:</strong> ${v.city}, ${v.pickuplocationaddress || v.pickupLocationAddress}
                            </div>
                            <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 12px;">
                                <strong style="color: #fff;">Specs:</strong> ${v.fueltype || 'Petrol'} • ${v.transmission || 'Manual'} • ${v.seatingcapacity || 5} Seats
                            </div>
                        </div>

                        <div style="border-top: 1px solid var(--border); pt-3; padding-top: 12px; display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <span style="font-size: 1.2rem; font-weight: 800; color: var(--success);">₹${v.priceperday || v.pricePerDay}</span>
                                <span style="font-size: 0.75rem; color: var(--text-dim);"> / day</span>
                            </div>
                            <button class="btn btn-secondary btn-sm" onclick="toggleRentalVehicleStatus('${v.id}', '${v.status}')">
                                Toggle Status
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error('Error rendering rental fleet:', err);
    }
}

async function openAddRentalVehicleModal() {
    let partnersOptions = '<option value="">Loading partners...</option>';
    try {
        const res = await fetch(`${API_URL}/rental-partners/nearby`);
        const data = await res.json();
        if (data.partners && data.partners.length > 0) {
            partnersOptions = data.partners.map(p => `<option value="${p.id}">${p.businessName} (${p.serviceCity})</option>`).join('');
        } else {
            partnersOptions = '<option value="">No approved partners found. Approve a partner first!</option>';
        }
    } catch (e) {
        partnersOptions = '<option value="">Error loading partners</option>';
    }

    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-rental-vehicle" style="display:flex;">
            <div class="modal-content" style="max-width:600px; width:95%; max-height:90vh; overflow-y:auto; background:var(--card-bg, #12141a); border:1px solid var(--border); border-radius:16px; padding:24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:14px;">
                    <h2 style="font-size:1.25rem; font-weight:700; color:#fff; margin:0;">Add Rental Vehicle to Partner Fleet</h2>
                    <button class="btn-icon" onclick="closeModal('modal-add-rental-vehicle')"><i data-lucide="x"></i></button>
                </div>

                <!-- Admin Override Notice -->
                <div style="background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.15); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 0.85rem; color: #93c5fd; display: flex; align-items: flex-start; gap: 8px;">
                    <i data-lucide="info" style="width: 16px; height: 16px; margin-top: 2px; flex-shrink: 0; color: #60a5fa;"></i>
                    <div>
                        <strong>Secondary Admin Override:</strong> Approved rental partners can add and manage vehicles directly from their Customer App "Partner Fleet Dashboard". Use this form only for manual admin assistance.
                    </div>
                </div>

                <form onsubmit="submitAddRentalVehicle(event)" style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
                    <div style="grid-column: 1 / -1;">
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Approved Rental Partner *</label>
                        <select id="rv-partner-id" required class="input" style="width:100%;">
                            <option value="">-- Select Partner --</option>
                            ${partnersOptions}
                        </select>
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Vehicle Type *</label>
                        <select id="rv-type" required class="input" style="width:100%;">
                            <option value="car">Car</option>
                            <option value="bike">Bike / Scooter</option>
                        </select>
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Plate Number *</label>
                        <input id="rv-plate" required class="input" placeholder="e.g. MH 02 CD 5678" style="width:100%; text-transform:uppercase;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Make / Brand *</label>
                        <input id="rv-make" required class="input" placeholder="e.g. Hyundai, Honda, Maruti" style="width:100%;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Model Name *</label>
                        <input id="rv-model" required class="input" placeholder="e.g. Creta, Swift, Activa" style="width:100%;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Manufacture Year</label>
                        <input id="rv-year" type="number" value="2023" class="input" style="width:100%;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Fuel Type</label>
                        <select id="rv-fuel" class="input" style="width:100%;">
                            <option value="Petrol">Petrol</option>
                            <option value="Diesel">Diesel</option>
                            <option value="EV">EV / Electric</option>
                            <option value="CNG">CNG</option>
                        </select>
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Transmission</label>
                        <select id="rv-transmission" class="input" style="width:100%;">
                            <option value="Manual">Manual</option>
                            <option value="Automatic">Automatic</option>
                        </select>
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Seating Capacity</label>
                        <input id="rv-seating" type="number" value="5" class="input" style="width:100%;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Rate Per Day (₹) *</label>
                        <input id="rv-price-day" type="number" required placeholder="e.g. 2500" class="input" style="width:100%;" />
                    </div>

                    <div>
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">City Location *</label>
                        <input id="rv-city" required placeholder="e.g. Mumbai" value="Mumbai" class="input" style="width:100%;" />
                    </div>

                    <div style="grid-column: 1 / -1;">
                        <label style="font-size:0.8rem; color:var(--text-dim); display:block; margin-bottom:6px;">Pickup Address / Hub Location *</label>
                        <input id="rv-pickup-address" required placeholder="e.g. Shop 12, Andheri West Hub, Mumbai" class="input" style="width:100%;" />
                    </div>

                    <div style="grid-column: 1 / -1; display:flex; gap:12px; margin-top:12px;">
                        <button type="button" class="btn btn-secondary" style="flex:1;" onclick="closeModal('modal-add-rental-vehicle')">Cancel</button>
                        <button type="submit" class="btn btn-primary" style="flex:2;">Add Vehicle to Fleet</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.getElementById('modal-container').innerHTML = modalHtml;
    if (window.lucide) lucide.createIcons();
}

async function submitAddRentalVehicle(event) {
    event.preventDefault();
    const partnerId = document.getElementById('rv-partner-id').value;
    const vehicleType = document.getElementById('rv-type').value;
    const plateNumber = document.getElementById('rv-plate').value;
    const make = document.getElementById('rv-make').value;
    const model = document.getElementById('rv-model').value;
    const year = document.getElementById('rv-year').value;
    const fuelType = document.getElementById('rv-fuel').value;
    const transmission = document.getElementById('rv-transmission').value;
    const seatingCapacity = document.getElementById('rv-seating').value;
    const pricePerDay = document.getElementById('rv-price-day').value;
    const city = document.getElementById('rv-city').value;
    const pickupLocationAddress = document.getElementById('rv-pickup-address').value;

    try {
        const res = await fetch(`${API_URL}/rental-vehicles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                partnerId, vehicleType, make, model, year, plateNumber,
                fuelType, transmission, seatingCapacity, pricePerDay, city, pickupLocationAddress
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add rental vehicle');

        await showAlert('Success', 'Rental vehicle added successfully to partner fleet!', 'Done', 'success');
        closeModal('modal-add-rental-vehicle');
        renderRentalFleet(document.getElementById('app'));
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function toggleRentalVehicleStatus(vehicleId, currentStatus) {
    const newStatus = currentStatus === 'available' ? 'maintenance' : currentStatus === 'maintenance' ? 'disabled' : 'available';
    try {
        const res = await fetch(`${API_URL}/rental-vehicles/${vehicleId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) throw new Error('Status update failed');
        renderRentalFleet(document.getElementById('app'));
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}


async function reviewMarshalKYC(marshalId) {
    console.log('Reviewing KYC for Marshal ID:', marshalId);
    
    // Resilient lookup: Check both users and workers, handle string/number mismatches
    const m = PROTOTYPE_STATE.users.find(u => String(u.id) === String(marshalId)) || 
              PROTOTYPE_STATE.workers.find(w => String(w.id) === String(marshalId));
              
    if (!m) {
        console.error('Marshal not found in state:', marshalId);
        return alert('Driver data not found in local state. Please wait for sync.');
    }

    // Determine type for header
    const mType = PROTOTYPE_STATE.users.find(u => String(u.id) === String(marshalId)) ? 'Platform' : 'Garage';
    const gName = mType === 'Garage' ? (PROTOTYPE_STATE.garages.find(g => g.id === m.garageId)?.name || 'Unknown Garage') : null;
    
    const cleanPanUrl = '/' + (m.panUrl || m.panurl || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanAadhaarUrl = '/' + (m.aadhaarUrl || m.aadhaarurl || '').replace(/\\/g, '/').replace(/^\/+/, '');

    const hasPan = !!(m.panNumber || m.pannumber || m.panUrl || m.panurl);
    const hasAadhaar = !!(m.aadhaarNumber || m.aadhaarnumber || m.aadhaarUrl || m.aadhaarurl);
    const idBadge = hasAadhaar ? '<span class="badge badge-info" style="font-size:0.6rem; background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3);">ID: AADHAAR</span>' : (hasPan ? '<span class="badge badge-info" style="font-size:0.6rem; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">ID: PAN</span>' : '');

    const rawVTypes = m.vehicle_types || m.vehicletype || m.vehicleType || 'bike';
    const vTypesArr = typeof rawVTypes === 'string' ? rawVTypes.split(',').map(s => s.trim().toLowerCase()) : (Array.isArray(rawVTypes) ? rawVTypes : ['bike']);
    const hasBike = vTypesArr.includes('bike');
    const hasCar = vTypesArr.includes('car') || vTypesArr.includes('auto');
    let vehicleBadge = '';
    if (hasBike && hasCar) {
        vehicleBadge = '<span class="badge" style="font-size:0.6rem; background:rgba(212,175,55,0.15); color:#D4AF37; border:1px solid rgba(212,175,55,0.3);">🚗 CAR + 🏍️ BIKE</span>';
    } else if (hasCar) {
        vehicleBadge = '<span class="badge" style="font-size:0.6rem; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">🚗 CAR</span>';
    } else {
        vehicleBadge = '<span class="badge" style="font-size:0.6rem; background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3);">🏍️ BIKE</span>';
    }

    const modalHtml = `
        <div class="modal-overlay open" id="modal-review-kyc" style="display:flex;">
            <div class="modal-content" style="max-width: 600px; width: 90%; max-height: 90vh; display: flex; flex-direction: column; background:#121212; border:1px solid #333;">
                <header style="display:flex; align-items:center; gap:15px; border-bottom:1px solid #333; padding-bottom:15px; margin-bottom:20px; padding: 20px 20px 15px 20px;">
                    <div style="width:60px; height:60px; border-radius:50%; overflow:hidden; border:2px solid var(--primary); background:#000;">
                        ${(m.facePhotoUrl || m.facephotourl) ? 
                            `<img src="${getAttachmentUrl(m.facePhotoUrl || m.facephotourl)}" style="width:100%; height:100%; object-fit:cover;">` : 
                            `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--primary); font-weight:700; font-size:1.5rem;">${m.name.charAt(0).toUpperCase()}</div>`
                        }
                    </div>
                    <div style="flex:1;">
                        <h2 style="margin:0; font-size:1.3rem; color:#fff;">Review KYC: ${m.name}</h2>
                        <div style="font-size:0.75rem; color:var(--text-dim); margin-top:4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <span class="badge ${mType === 'Platform' ? 'badge-primary' : 'badge-secondary'}" style="font-size:0.6rem;">${mType.toUpperCase()}</span>
                            ${idBadge}
                            ${vehicleBadge}
                            <span class="badge ${m.kycStatus === 'verified' || m.kycStatus === 'approved' || m.kycStatus === 'Approved' ? 'badge-success' : (m.kycStatus === 'pending_approval' || m.kycStatus === 'Pending Approval' ? 'badge-warning' : 'badge-danger')}" style="font-size:0.6rem;">
                                ${(m.kycStatus || 'NOT STARTED').replace('_', ' ').toUpperCase()}
                            </span>
                            ${gName ? `<span style="margin-left:8px;">Affiliated with: <b>${gName}</b></span>` : ''}
                        </div>
                    </div>
                    <button onclick="closeModal('modal-review-kyc')" class="btn btn-secondary" style="padding:4px 10px;">✕</button>
                </header>
                <div class="modal-body" style="display:flex; flex-direction:column; gap:20px; overflow-y:auto; flex:1; padding: 0 20px 20px 20px;">
                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--primary); margin-bottom:12px;">Financial & ID Documents</h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px;">
                            <div>
                                <label class="label">PAN NUMBER</label>
                                <div style="font-weight:700; color:var(--text-main); margin-bottom:8px;">${(m.panNumber || m.pannumber) || (hasAadhaar ? 'Not Provided (Aadhaar Selected)' : 'Not Provided')}</div>
                                <div style="display:flex; flex-direction:column; gap:6px;">
                                    ${(m.panUrl || m.panurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Front' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Front'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Front
                                        </button>
                                        <img src="${getAttachmentUrl(m.panUrl || m.panurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : `<div class="badge" style="padding:6px; text-align:center;">${hasAadhaar ? 'Skipped (Aadhaar Used)' : 'No Front Photo'}</div>`}
                                    ${(m.panBackUrl || m.panbackurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Back' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Back'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Back
                                        </button>
                                        <img src="${getAttachmentUrl(m.panBackUrl || m.panbackurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : `<div class="badge" style="padding:6px; text-align:center;">${hasAadhaar ? 'Skipped (Aadhaar Used)' : 'No Back Photo'}</div>`}
                                </div>
                            </div>
                            <div>
                                <label class="label">AADHAAR NUMBER</label>
                                <div style="font-weight:700; color:var(--text-main); margin-bottom:8px;">${(m.aadhaarNumber || m.aadhaarnumber) || (hasPan ? 'Not Provided (PAN Selected)' : 'Not Provided')}</div>
                                <div style="display:flex; flex-direction:column; gap:6px;">
                                    ${(m.aadhaarUrl || m.aadhaarurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Front' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Front'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Front
                                        </button>
                                        <img src="${getAttachmentUrl(m.aadhaarUrl || m.aadhaarurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : `<div class="badge" style="padding:6px; text-align:center;">${hasPan ? 'Skipped (PAN Used)' : 'No Front Photo'}</div>`}
                                    ${(m.aadhaarBackUrl || m.aadhaarbackurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Back' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Back'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Back
                                        </button>
                                        <img src="${getAttachmentUrl(m.aadhaarBackUrl || m.aadhaarbackurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : `<div class="badge" style="padding:6px; text-align:center;">${hasPan ? 'Skipped (PAN Used)' : 'No Back Photo'}</div>`}
                                </div>
                            </div>

                            <div>
                                <label class="label">DRIVING LICENSE</label>
                                <div style="font-weight:700; color:var(--text-main); margin-bottom:8px;">${(m.dlNumber || m.dlnumber) || 'Not Provided'}</div>
                                <div style="display:flex; flex-direction:column; gap:6px;">
                                    ${(m.dlUrl || m.dlurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Front' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Front'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Front
                                        </button>
                                        <img src="${getAttachmentUrl(m.dlUrl || m.dlurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : '<div class="badge" style="padding:6px; text-align:center;">No Front Photo</div>'}
                                    ${(m.dlBackUrl || m.dlbackurl) ? `
                                        <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Back' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Back'; if (window.lucide) lucide.createIcons();">
                                            <i data-lucide="eye" style="width:14px;"></i> View Back
                                        </button>
                                        <img src="${getAttachmentUrl(m.dlBackUrl || m.dlbackurl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                    ` : '<div class="badge" style="padding:6px; text-align:center;">No Back Photo</div>'}
                                </div>
                            </div>
                            <div>
                                <label class="label">LIVE SELFIE</label>
                                <div style="font-weight:700; color:var(--text-main); margin-bottom:8px;">Selfie Photo</div>
                                ${(m.facePhotoUrl || m.facephotourl) ? `
                                    <button class="btn btn-secondary btn-sm" style="width:100%; padding:6px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border); font-size:0.75rem;" onclick="const img = this.nextElementSibling; const isHidden = img.style.display === 'none'; img.style.display = isHidden ? 'block' : 'none'; this.innerHTML = isHidden ? '<i data-lucide=\\'eye-off\\' style=\\'width:14px;\\'></i> Hide Selfie' : '<i data-lucide=\\'eye\\' style=\\'width:14px;\\'></i> View Selfie'; if (window.lucide) lucide.createIcons();">
                                        <i data-lucide="eye" style="width:14px;"></i> View Selfie
                                    </button>
                                    <img src="${getAttachmentUrl(m.facePhotoUrl || m.facephotourl)}" style="display:none; width:100%; max-height:220px; object-fit:contain; margin-top:4px; border-radius:6px; border:1px solid var(--border); background:#000;" />
                                ` : '<div class="badge" style="padding:6px; text-align:center;">No Photo</div>'}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--info); margin-bottom:12px;">Bank Payout Details</h3>
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">Bank Name</span>
                                <span style="font-weight:700; color:var(--text-main);">${(m.bankName || m.bankname) || 'N/A'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">Account Name</span>
                                <span style="font-weight:700;">${(m.bankAccountName || m.bankaccountname) || 'N/A'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">Account Number</span>
                                <span style="font-weight:700;">${(m.bankAccountNumber || m.bankaccountnumber) || 'N/A'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">IFSC Code</span>
                                <span style="font-weight:700;">${(m.bankIFSC || m.bankifsc) || 'N/A'}</span>
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border);">
                        <h3 style="font-size:0.9rem; color:var(--primary); margin-bottom:12px;">Residential Address</h3>
                        <div style="display:flex; flex-direction:column; gap:8px; font-size:0.85rem;">
                            <div style="display:flex; justify-content:space-between; align-items: flex-start; gap: 15px;">
                                <span style="color:var(--text-dim); min-width: 80px;">Address</span>
                                <span style="font-weight:700; text-align: right; color:#fff;">${m.address || 'Not Provided'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">City</span>
                                <span style="font-weight:700; color:#fff;">${m.city || 'Not Provided'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">State</span>
                                <span style="font-weight:700; color:#fff;">${m.state || 'Not Provided'}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between;">
                                <span style="color:var(--text-dim);">Pincode</span>
                                <span style="font-weight:700; color:#fff;">${m.pincode || 'Not Provided'}</span>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                        ${((m.kycStatus || m.kycstatus) === 'pending_approval' || (m.kycStatus || m.kycstatus) === 'Pending Approval' || (m.kycStatus || m.kycstatus) === 'pending_submission') ? `
                            <div style="display:flex; gap:12px;">
                                <button class="btn btn-danger" style="flex:1;" onclick="rejectMarshal('${m.id}')">
                                    <i data-lucide="alert-circle"></i> Request Resubmit
                                </button>
                                <button class="btn btn-success" style="flex:1.5;" onclick="approveMarshal('${m.id}')">
                                    <i data-lucide="check-circle"></i> Approve Driver
                                </button>
                            </div>
                        ` : `
                            <div style="display:flex; gap:12px;">
                                ${((m.kycStatus || m.kycstatus) === 'verified' || (m.kycStatus || m.kycstatus) === 'approved' || (m.kycStatus || m.kycstatus) === 'Approved') ? `
                                    <button class="btn" style="flex:1; background:rgba(255,165,0,0.1); color:orange; border:1px solid rgba(255,165,0,0.3);" onclick="requestKycReverification('${m.id}')">
                                        <i data-lucide="refresh-ccw"></i> Re-verify KYC
                                    </button>
                                ` : ''}
                                <button class="btn btn-danger" style="flex:1;" onclick="suspendUser('${m.id}')">
                                    <i data-lucide="user-x"></i> Suspend Account
                                </button>
                            </div>
                        `}
                        <button class="btn btn-secondary" style="width:100%;" onclick="closeModal('modal-review-kyc')">Close</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.getElementById('modal-container').innerHTML = modalHtml;
    if (window.lucide) lucide.createIcons();
}

async function approveMarshal(marshalId) {
    const confirmed = await showConfirm(
        'Approve Marshal?', 
        'Are you sure you want to approve this marshal? They will be able to start accepting pickups immediately.',
        'Approve'
    );
    if (!confirmed) return;

    try {
        const res = await fetch(`${API_URL}/users/${marshalId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                kycStatus: 'Approved',
                panVerified: 1,
                aadhaarVerified: 1,
                bankVerified: 1,
                dlVerified: 1
            })
        });

        if (!res.ok) throw new Error('Approval failed');

        await showAlert('Success', 'Driver Approved Successfully!', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function rejectMarshal(marshalId) {
    console.log("rejectMarshal called with ID:", marshalId);
    const reason = await window.customShowPrompt('Please provide a reason for requesting document resubmission:');
    if (reason === null) return;

    try {
        const res = await fetch(`${API_URL}/users/${marshalId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                kycStatus: 'Re-submit KYC',
                kycRejectionReason: reason || 'Documents do not meet our criteria.'
            })
        });

        if (!res.ok) throw new Error('Rejection failed');

        await showAlert('Success', 'Driver Request Rejected.', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function requestKycReverification(userId) {
    if(!await showConfirm('Request Re-verification?', 'Are you sure you want to request KYC re-verification? This will lock their app until they submit documents again.', 'Request', 'primary')) return;
    try {
        const res = await fetch(`${API_URL}/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kycStatus: 'pending_submission' })
        });
        if (!res.ok) throw new Error('Failed to request re-verification');
        await showAlert('Success', 'KYC Re-verification requested.', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

async function suspendUser(userId) {
    if(!await showConfirm('Suspend Account?', 'Are you sure you want to suspend this account? They will be permanently locked out.', 'Suspend', 'danger')) return;
    try {
        const res = await fetch(`${API_URL}/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'suspended' })
        });
        if (!res.ok) throw new Error('Failed to suspend account');
        await showAlert('Success', 'Account suspended successfully.', 'Done', 'success');
        closeModal('modal-review-kyc');
        fetchRealtimeData().then(() => refreshActiveUserView());
    } catch (err) {
        await showAlert('Error', err.message, 'Close', 'error');
    }
}

function filterMarshalsByProximity(val) {
    const coords = val.split(',').map(c => parseFloat(c.trim()));
    if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        window.marshalSearchLat = coords[0];
        window.marshalSearchLng = coords[1];
        renderProviderPage(document.getElementById('app'), 'drivers');
    } else {
        alert('Please enter valid coordinates: lat, lng');
    }
}

function renderAdminSurvey(container) {
    if (PROTOTYPE_STATE.currentUser.role !== 'Admin') {
        container.innerHTML = '<div class="card">Access Denied</div>';
        return;
    }

    const html = `
        <div class="fade-in">
            <header class="page-header">
                <div>
                    <h1 class="page-title">Survey Configuration</h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">Customize the driver survey flow and script</p>
                </div>
                <button onclick="router.navigate('admin')" class="btn btn-secondary">
                    <i data-lucide="arrow-left"></i> Back to Admin
                </button>
            </header>
            
            <div class="card" style="margin-bottom: 25px">
                <h3 style="margin-bottom: 15px;">Introductory Script</h3>
                <p style="font-size: 0.85rem; color: var(--text-dim); margin-bottom: 15px;">This text is displayed to the surveyor at the start of every survey.</p>
                <textarea id="admin-survey-script" class="input" rows="6" style="margin-top:10px; font-family: inherit;">${PROTOTYPE_STATE.startScript}</textarea>
                <div style="text-align:right; margin-top:15px">
                    <button onclick="saveSurveyScript()" class="btn btn-primary">Update Script</button>
                </div>
            </div>

            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px">
                     <div>
                        <h3>Survey Questions</h3>
                        <p style="font-size: 0.85rem; color: var(--text-dim);">${PROTOTYPE_STATE.surveyQuestions.length} questions currently active</p>
                     </div>
                     <button onclick="openAddQuestionModal()" class="btn btn-primary">
                        <i data-lucide="plus"></i> Add Question
                     </button>
                </div>

                <div style="display: flex; flex-direction: column; gap: 12px;">
                    ${PROTOTYPE_STATE.surveyQuestions.map((q, idx) => `
                        <div style="border: 1px solid var(--border); padding: 18px; border-radius: 12px; background: rgba(255,255,255,0.01);">
                            <div style="display:flex; justify-content:space-between; align-items: flex-start;">
                                <div style="font-weight: 600; font-size: 1.05rem;">
                                    <span style="color: var(--primary); margin-right: 8px;">Q${idx + 1}.</span> ${q.text}
                                </div>
                                <div style="display: flex; gap: 8px;">
                                    <button onclick="openEditQuestionModal(${q.id})" class="btn btn-secondary btn-sm">Edit</button>
                                    <button onclick="deleteQuestion(${q.id})" class="btn btn-danger btn-sm">Delete</button>
                                </div>
                            </div>
                            <div style="margin-top: 12px; color: var(--text-dim); font-size: 0.85rem; display: flex; flex-wrap: wrap; gap: 8px;">
                                <span style="color: var(--text-muted)">Options:</span>
                                ${q.options.map(opt => `<span style="background: var(--bg-surface); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border);">${opt}</span>`).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function saveSurveyScript() {
    const val = document.getElementById('admin-survey-script').value;
    PROTOTYPE_STATE.startScript = val;
    saveState();
    alert('Script updated!');
}

function deleteQuestion(id) {
    if (!confirm('Are you sure you want to delete this question?')) return;
    PROTOTYPE_STATE.surveyQuestions = PROTOTYPE_STATE.surveyQuestions.filter(q => q.id !== id);
    saveState();
    renderAdminSurvey(document.getElementById('app'));
}

function openAddQuestionModal() {
    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-question">
            <div class="modal-content">
                <h2>Add New Question</h2>
                <div class="form-group">
                    <label class="label">Question Text</label>
                    <input type="text" id="new-q-text" class="input">
                </div>
                <div class="form-group">
                    <label class="label">Options (comma separated)</label>
                    <input type="text" id="new-q-opts" class="input" placeholder="Option 1, Option 2, Option 3">
                </div>
                <div style="text-align: right; margin-top: 20px">
                     <button onclick="closeModal('modal-add-question')" class="btn btn-secondary">Cancel</button>
                     <button onclick="saveNewQuestion()" class="btn btn-primary">Add</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

function saveNewQuestion() {
    const text = document.getElementById('new-q-text').value;
    const optsStr = document.getElementById('new-q-opts').value;

    if (!text || !optsStr) {
        alert('All fields required'); return;
    }

    const newQ = {
        id: Date.now(),
        text,
        options: optsStr.split(',').map(s => s.trim())
    };

    PROTOTYPE_STATE.surveyQuestions.push(newQ);
    saveState();
    closeModal('modal-add-question');
    renderAdminSurvey(document.getElementById('app'));
}

let editingQuestionId = null;

function openEditQuestionModal(id) {
    const q = PROTOTYPE_STATE.surveyQuestions.find(sq => sq.id === id);
    if (!q) return;

    editingQuestionId = id;

    const modalHtml = `
        <div class="modal-overlay open" id="modal-edit-question">
            <div class="modal-content">
                <h2>Edit Question</h2>
                <div class="form-group">
                    <label class="label">Question Text</label>
                    <input type="text" id="edit-q-text" class="input" value="${q.text}">
                </div>
                <div class="form-group">
                    <label class="label">Options (comma separated)</label>
                    <input type="text" id="edit-q-opts" class="input" value="${q.options.join(', ')}">
                </div>
                <div style="text-align: right; margin-top: 20px">
                     <button onclick="closeModal('modal-edit-question')" class="btn btn-secondary">Cancel</button>
                     <button onclick="saveEditedQuestion()" class="btn btn-primary">Save Changes</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

function saveEditedQuestion() {
    const text = document.getElementById('edit-q-text').value;
    const optsStr = document.getElementById('edit-q-opts').value;

    if (!text || !optsStr) {
        alert('All fields required'); return;
    }

    const qIndex = PROTOTYPE_STATE.surveyQuestions.findIndex(sq => sq.id === editingQuestionId);
    if (qIndex > -1) {
        PROTOTYPE_STATE.surveyQuestions[qIndex].text = text;
        PROTOTYPE_STATE.surveyQuestions[qIndex].options = optsStr.split(',').map(s => s.trim());
        saveState();
    }

    closeModal('modal-edit-question');
    renderAdminSurvey(document.getElementById('app'));
}

// Replaced by final listener at line 2106

// --- Pages ---

function renderLogin(container) {
    const html = `
        <div style="display: flex; justify-content: center; align-items: center; height: 100vh; background: var(--bg-base);">
            <div class="card" style="width: 100%; max-width: 400px; padding: 40px; border: 1px solid var(--border-bright);">
                <div style="text-align: center; margin-bottom: 40px;">
                    <img src="assets/redrivo_logo_transparent_dark_bg.png" alt="ReDrivo Logo" style="width: 160px; height: auto; margin: 0 auto 12px; display: block;" />
                    <p style="color:var(--text-dim); font-size:0.9rem; margin-top:4px;">Operational Command Center</p>
                </div>
                
                <div class="form-group">
                    <label class="label">SECURE IDENTIFIER</label>
                    <input type="text" id="login-id" class="input" placeholder="admin@redrivo.com">
                </div>
                <div class="form-group" style="margin-top:20px;">
                    <label class="label">ACCESS KEY</label>
                    <input type="password" id="login-pass" class="input" placeholder="••••••••">
                </div>
                
                <button onclick="handleLogin()" class="btn btn-primary" style="width: 100%; margin-top: 30px; height: 50px; font-weight:700;">
                    Initialize Access
                </button>
                
                <div style="text-align: center; margin-top: 25px; color: var(--text-dim); font-size: 0.85rem; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 8px;">
                    <i data-lucide="info" style="width:14px; vertical-align:middle; margin-right:4px;"></i>
                    Dev Access: <strong>admin@redrivo.com</strong> / <strong>admin</strong>
                </div>
                
                <div style="margin: 30px 0; display:flex; align-items:center; gap:10px;">
                    <div style="flex:1; height:1px; background:var(--border);"></div>
                    <span style="font-size:0.75rem; color:var(--text-dim); font-weight:700;">OR</span>
                    <div style="flex:1; height:1px; background:var(--border);"></div>
                </div>
                
                <div style="text-align: center;">
                    <button onclick="window.location.hash='#public-survey'; location.reload();" class="btn btn-secondary" style="width: 100%; height: 50px;">
                        <i data-lucide="clipboard-list"></i> Public Survey Portal
                    </button>
                    <p style="font-size: 0.75rem; color: var(--text-dim); margin-top: 10px;">No authentication required for surveys</p>
                </div>
            </div>
        </div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
}

async function handleLogin() {
    const identifier = document.getElementById('login-id').value;
    const password = document.getElementById('login-pass').value;

    if (!identifier || !password) {
        alert('Please enter both ID and Password');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password })
        });

        const data = await response.json();

        if (response.ok) {
            PROTOTYPE_STATE.currentUser = data;
            localStorage.setItem('redrivo_current_user', JSON.stringify(data));
            if (data.token) {
                localStorage.setItem('redrivo_token', data.token);
            }
            router.navigate('dashboard');
        } else {
            alert(data.error || 'Invalid Credentials');
        }
    } catch (err) {
        console.error('Login Error:', err);
        alert('Connection error. Is the backend running?');
    }
}

function handleLogout() {
    PROTOTYPE_STATE.currentUser = null;
    localStorage.removeItem('redrivo_current_user');
    localStorage.removeItem('redrivo_token');
    router.navigate('login');
}

// Replaced by premium renderDashboard at line 235


// --- Survey Analysis Logic ---

function getSurveyMetrics(filterSource = 'all') {
    const metrics = {};
    const filteredCustomers = PROTOTYPE_STATE.customers.filter(c => {
        const hasAnswers = c.surveyAnswers && Object.keys(c.surveyAnswers).length > 0;
        if (!hasAnswers) return false;
        if (filterSource === 'all') return true;
        return c.source === filterSource;
    });

    const totalResponses = filteredCustomers.length;

    PROTOTYPE_STATE.surveyQuestions.forEach(q => {
        metrics[q.id] = {
            text: q.text,
            counts: {},
            total: 0
        };
        q.options.forEach(opt => {
            metrics[q.id].counts[opt] = 0;
        });
    });

    filteredCustomers.forEach(customer => {
        Object.keys(customer.surveyAnswers).forEach(qId => {
            const answers = customer.surveyAnswers[qId];
            if (!metrics[qId]) return;
            answers.forEach(ans => {
                const baseAns = ans.startsWith('Other:') ? 'Other' : ans;
                if (metrics[qId].counts.hasOwnProperty(baseAns)) {
                    metrics[qId].counts[baseAns]++;
                    metrics[qId].total++;
                }
            });
        });
    });

    const totalCustomers = PROTOTYPE_STATE.customers.length;
    const participationRate = totalCustomers > 0 ? Math.round((totalResponses / totalCustomers) * 100) : 0;

    return { metrics, totalResponses, totalCustomers, participationRate };
}

function renderSurveyDashboard(container) {
    const activeFilter = surveyState.dashboardFilter || 'all';
    const { metrics, totalResponses, totalCustomers, participationRate } = getSurveyMetrics(activeFilter);

    const sources = ['all', 'Manual', 'Social Media - Instagram', 'Social Media - Facebook', 'Social Media - YouTube', 'Offline Agent'];

    const html = `
        <div class="header">
            <h1 class="page-title">Survey Analysis</h1>
            <div>
                <div style="display:flex; gap: 10px; align-items: center">
                    <div class="label" style="font-size: 0.8rem">Filter by Source:</div>
                    <select class="select" style="padding: 4px 10px; font-size: 0.8rem; width: auto" onchange="surveyState.dashboardFilter = this.value; renderSurveyDashboard(document.getElementById('app'))">
                        ${sources.map(s => `<option value="${s}" ${activeFilter === s ? 'selected' : ''}>${s.replace('Social Media - ', '')}</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>

        <div class="grid-4" style="margin-bottom: var(--space-xl)">
            <div class="card">
                <div class="label">Total Responses</div>
                <div style="font-size: 1.5rem; font-weight: 700;">${totalResponses}</div>
            </div>
            <div class="card">
                <div class="label">CRM Customers</div>
                <div style="font-size: 1.5rem; font-weight: 700;">${totalCustomers}</div>
            </div>
            <div class="card">
                <div class="label">Participation Rate</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--success)">${participationRate}%</div>
            </div>
            <div class="card">
                <div class="label">Filter Active</div>
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--info)">${activeFilter.replace('Social Media - ', '')}</div>
            </div>
        </div>

        <div class="grid-2">
            <!-- Key Insight 1: Pain Points -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="alert-circle" style="vertical-align: middle; margin-right: 8px"></i> Top Customer Pain Points</h3>
                ${renderMetricBars(metrics[10])}
            </div>

            <!-- Key Insight 2: Service Preferences -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="settings" style="vertical-align: middle; margin-right: 8px"></i> Preferred Service Models</h3>
                ${renderMetricBars(metrics[8])}
            </div>

            <!-- Key Insight 3: Communication -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="message-square" style="vertical-align: middle; margin-right: 8px"></i> Communication Preferences</h3>
                ${renderMetricBars(metrics[9])}
            </div>

            <!-- Key Insight 4: Language -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="languages" style="vertical-align: middle; margin-right: 8px"></i> Language Comfort</h3>
                ${renderMetricBars(metrics[1])}
            </div>
            
            <!-- Key Insight 5: Trust Factors -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="shield-check" style="vertical-align: middle; margin-right: 8px"></i> Trust Markers</h3>
                ${renderMetricBars(metrics[11])}
            </div>

            <!-- Key Insight 6: Value of Reports -->
            <div class="card">
                <h3 style="margin-bottom: 20px;"><i data-lucide="file-text" style="vertical-align: middle; margin-right: 8px"></i> Confidence in Digital Reports</h3>
                ${renderMetricBars(metrics[13])}
            </div>
        </div>

        <div class="card" style="margin-top: var(--space-xl)">
            <h3 style="margin-bottom: 20px;">All Survey Questions Aggregated</h3>
            <div style="display: flex; flex-direction: column; gap: 30px">
                ${PROTOTYPE_STATE.surveyQuestions.map(q => `
                    <div>
                        <div style="font-weight: 600; margin-bottom: 10px; color: var(--text-muted)">Q${q.id}: ${q.text}</div>
                        ${renderMetricBars(metrics[q.id], true)}
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    container.innerHTML = html;
    lucide.createIcons();
}

// --- Survey Wizard Logic ---

function renderSurveyWizard(container) {
    surveyState.wizardStep = 0;
    surveyState.answers = {};
    surveyState.contact = {
        name: '', phone: '', email: '',
        phoneVerified: false, emailVerified: false,
        address: '', source: 'Manual'
    };
    renderSurveyStep(container);
}

function renderSurveyStep(container) {
    const questions = PROTOTYPE_STATE.surveyQuestions;
    const currentStep = surveyState.wizardStep;

    let content = '';

    // Step 0: Script
    if (currentStep === 0) {
        content = `
            <div class="card" style="max-width: 600px; margin: 0 auto; text-align: center; padding: 40px;">
                <h2 style="margin-bottom: 20px;">ReDrivo Pre-Service Survey</h2>
                <div style="text-align: left; background: rgba(255,255,255,0.02); padding: 20px; border-radius: 8px; margin-bottom: 30px; white-space: pre-wrap; font-size: 1.1rem; line-height: 1.6; border: 1px solid var(--border);">${PROTOTYPE_STATE.startScript}</div>
                <button onclick="nextSurveyStep()" class="btn btn-primary" style="padding: 12px 30px; font-size: 1.1rem">Start Survey →</button>
            </div>
        `;
    }
    // Questions Steps
    else if (currentStep <= questions.length) {
        const q = questions[currentStep - 1];
        content = `
            <div class="card" style="max-width: 600px; margin: 0 auto; padding: 30px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; color: var(--text-dim)">
                    <span>Question ${currentStep} of ${questions.length}</span>
                    <div style="text-align:right">
                         <div style="width: 50px; height: 50px; background: var(--primary-dim); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--primary); font-weight: 700; margin-left: auto;">H</div>
                        <span style="font-size:0.75rem; color: var(--text-muted)">ReDrivo Assistant</span>
                    </div>
                </div>
                
                <h2 style="margin-bottom: 30px; font-size: 1.4rem">${q.text}</h2>
                
                <div style="display:flex; flex-direction: column; gap: 12px; margin-bottom: 30px;">
                    ${q.options.map((opt, idx) => `
                        <label style="display:flex; align-items:center; padding: 15px; background: rgba(255,255,255,0.02); border-radius: 12px; cursor: pointer; border: 1px solid var(--border); transition: all 0.2s;">
                            <input type="checkbox" name="q-${q.id}" value="${opt}" onchange="updateSurveyAnswer(${q.id}, this.value)" ${surveyState.answers[q.id]?.includes(opt) ? 'checked' : ''} style="margin-right: 15px; width: 20px; height: 20px;">
                            <span style="font-size: 1.05rem">${opt}</span>
                        </label>
                    `).join('')}
                </div>

                <div style="display:flex; justify-content:space-between">
                    <button onclick="prevSurveyStep()" class="btn btn-secondary">← Back</button>
                    <button onclick="nextSurveyStep()" class="btn btn-primary">Next →</button>
                </div>
            </div>
        `;
    }
    // Final Step: Contact & Verification
    else {
        content = `
            <div class="card" style="max-width: 600px; margin: 0 auto; padding: 30px;">
                <h2 style="margin-bottom: 10px;">Almost Done!</h2>
                <p style="color: var(--text-dim); margin-bottom: 30px;">Please provide your contact details to complete the survey.</p>

                <div class="form-group">
                    <label class="label">Full Name</label>
                    <input type="text" id="s-name" class="input" value="${surveyState.contact.name}" oninput="surveyState.contact.name = this.value">
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">Phone Number</label>
                        <div style="display:flex; gap: 8px">
                            <input type="tel" id="s-phone" class="input" value="${surveyState.contact.phone}" oninput="surveyState.contact.phone = this.value">
                            ${surveyState.contact.phoneVerified ?
                                '<button class="btn btn-success" style="padding: 0 15px;" disabled><i data-lucide="check"></i></button>' :
                                '<button onclick="verifySurveyContact(\'phone\')" class="btn btn-secondary">Verify</button>'
                            }
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label class="label">Email Address</label>
                    <div style="display:flex; gap: 8px">
                        <input type="email" id="s-email" class="input" value="${surveyState.contact.email}" oninput="surveyState.contact.email = this.value">
                        ${surveyState.contact.emailVerified ?
                            '<button class="btn btn-success" style="padding: 0 15px;" disabled><i data-lucide="check"></i></button>' :
                            '<button onclick="verifySurveyContact(\'email\')" class="btn btn-secondary">Verify</button>'
                        }
                    </div>
                </div>

                <hr style="border: 0; border-top: 1px solid var(--border); margin: 25px 0">

                <div class="form-group">
                    <label class="label" style="display:flex; justify-content:space-between">
                        <span>Location / Address</span>
                        <span style="font-size:0.8rem; color:var(--primary); cursor:pointer" onclick="detectLocation()">📍 Auto-Detect</span>
                    </label>
                    <input type="text" id="s-address" class="input" placeholder="Address" value="${surveyState.contact.address}" oninput="surveyState.contact.address = this.value">
                </div>

                <div class="form-group">
                    <label class="label">Lead Source</label>
                    <select id="s-source" class="select" onchange="surveyState.contact.source = this.value; document.getElementById('agent-name-group').style.display = this.value === 'Offline Agent' ? 'block' : 'none'">
                        <option value="Manual">Manual Entry</option>
                        <option value="Social Media - Instagram">Instagram</option>
                        <option value="Social Media - Facebook">Facebook</option>
                        <option value="Social Media - YouTube">YouTube</option>
                        <option value="Offline Agent">Offline Agent</option>
                    </select>
                </div>
                
                 <div class="form-group" id="agent-name-group" style="display:none;">
                    <label class="label">Agent Name</label>
                    <input type="text" id="s-agent-name" class="input" placeholder="Enter Agent Name" oninput="surveyState.contact.agentName = this.value">
                </div>

                <div style="margin-top: 30px; display:flex; justify-content:space-between">
                    <button onclick="prevSurveyStep()" class="btn btn-secondary">← Back</button>
                    <button onclick="submitSurvey()" class="btn btn-primary">Submit & Create Prospect</button>
                </div>
            </div>
        `;
    }

    container.innerHTML = content;
    if (window.lucide) lucide.createIcons();
}

function updateSurveyAnswer(qId, val) {
    if (!surveyState.answers[qId]) surveyState.answers[qId] = [];
    const idx = surveyState.answers[qId].indexOf(val);
    if (idx > -1) {
        surveyState.answers[qId].splice(idx, 1);
    } else {
        surveyState.answers[qId].push(val);
    }
}

function nextSurveyStep() {
    surveyState.wizardStep++;
    renderSurveyStep(document.getElementById('app'));
}

function prevSurveyStep() {
    if (surveyState.wizardStep > 0) surveyState.wizardStep--;
    renderSurveyStep(document.getElementById('app'));
}

async function verifySurveyContact(type) {
    const val = type === 'phone' ? document.getElementById('s-phone').value : document.getElementById('s-email').value;
    if (!val) { await showAlert('Error', 'Please enter a value first', 'OK', 'danger'); return; }

    await showAlert('OTP Sent', `OTP Sent to ${val}: 1234`);
    const otp = await window.customShowPrompt('Enter OTP sent to your device:');

    if (otp === '1234') {
        if (type === 'phone') surveyState.contact.phoneVerified = true;
        if (type === 'email') surveyState.contact.emailVerified = true;
        renderSurveyStep(document.getElementById('app'));
    } else {
        await showAlert('Error', 'Invalid OTP', 'OK', 'danger');
    }
}

function detectLocation() {
    if (!confirm("ReDrivo CRM needs your location to track asset dispatch coordinates. Proceed?")) return;
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            document.getElementById('s-address').value = `Lat: ${pos.coords.latitude}, Long: ${pos.coords.longitude} (Auto-Detected)`;
            surveyState.contact.address = document.getElementById('s-address').value;
        }, () => {
            alert('Location access denied.');
        });
    }
}

async function submitSurvey() {
    const { name, phone, email, phoneVerified, emailVerified, source, agentName } = surveyState.contact;

    if (!name || !phone) { alert('Name and Phone are required.'); return; }
    if (!phoneVerified && !emailVerified) {
        if (!confirm('Contact details not verified. Proceed anyway?')) return;
    }

    const newProspect = {
        id: 'pros_' + Math.random().toString(36).substr(2, 9),
        name, phone, email,
        phoneVerified, emailVerified: emailVerified || false,
        address: surveyState.contact.address,
        source: source === 'Offline Agent' ? `Agent: ${agentName || 'Unknown'}` : source,
        type: 'Prospect',
        surveyAnswers: surveyState.answers,
        joinedDate: new Date().toISOString()
    };

    try {
        await fetch(`${API_URL}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newProspect)
        });
        alert('Prospect created successfully!');
        router.navigate('crm');
    } catch (e) {
        console.error(e);
        alert('Failed to save prospect.');
    }
}


function renderMetricBars(metric, compact = false) {
    if (!metric || metric.total === 0) return '<div class="text-muted">No data points yet</div>';

    return Object.keys(metric.counts).map(opt => {
        const count = metric.counts[opt];
        const percentage = Math.round((count / metric.total) * 100);

        return `
            <div style="margin-bottom: ${compact ? '8px' : '15px'}">
                <div style="display:flex; justify-content:space-between; font-size: 0.9rem; margin-bottom: 5px">
                    <span>${opt}</span>
                    <span style="font-weight: 600">${percentage}% (${count})</span>
                </div>
                <div style="height: ${compact ? '6px' : '10px'}; background: var(--bg-surface); border-radius: 5px; overflow: hidden; border: 1px solid var(--border)">
                    <div style="width: ${percentage}%; height: 100%; background: var(--primary)"></div>
                </div>
            </div>
        `;
    }).join('');
}

function renderAdmin(container) {
    if (PROTOTYPE_STATE.currentUser.role !== 'Admin') {
        container.innerHTML = '<div class="card">Access Denied</div>';
        return;
    }

    const html = `
        <div class="header">
            <h1 class="page-title">Admin Panel</h1>
            <div style="display:flex; gap: 10px">
                <button onclick="openAddUserModal()" class="btn btn-primary">
                    <i data-lucide="user-plus"></i> Add User
                </button>
                <button onclick="openAddGarageModal()" class="btn btn-primary">
                    <i data-lucide="warehouse"></i> Add Garage
                </button>
                <button onclick="router.navigate('admin-survey')" class="btn btn-secondary">
                    <i data-lucide="settings"></i> Survey Config
                </button>
            </div>
        </div>

        <div class="grid-2">
            <div class="card">
                <h3>Registered Users</h3>
                <div style="margin-top: var(--space-md); max-height: 400px; overflow-y: auto">
                    ${PROTOTYPE_STATE.users.map(u => `
                        <div style="display:flex; justify-content:space-between; padding: 10px 0; border-bottom: 1px solid var(--border)">
                            <div>
                                <div style="font-weight: 600">${u.name}</div>
                                <div style="color: var(--text-muted); font-size: 0.85rem">${u.email || u.phone} • ${u.role}</div>
                            </div>
                            <span class="badge" style="background: ${u.status === 'active' ? 'var(--success)' : 'var(--border)'}">${u.status}</span>
                        </div>
                    `).join('')}
                    ${PROTOTYPE_STATE.users.length === 0 ? '<div class="text-muted">No users registered.</div>' : ''}
                </div>
            </div>

            <div class="card">
                <h3>Partner Garages</h3>
                <div style="margin-top: var(--space-md); max-height: 400px; overflow-y: auto">
                    ${PROTOTYPE_STATE.garages.map(g => `
                        <div style="display:flex; justify-content:space-between; padding: 10px 0; border-bottom: 1px solid var(--border)">
                            <div>
                                <div style="font-weight: 600">${g.name}</div>
                                <div style="color: var(--text-muted); font-size: 0.85rem">${g.contact} • ${g.location || 'No Location'}</div>
                            </div>
                            <span class="badge badge-primary">${g.type}</span>
                        </div>
                    `).join('')}
                    ${PROTOTYPE_STATE.garages.length === 0 ? '<div class="text-muted">No garages onboarded.</div>' : ''}
                </div>
            </div>
        </div>
        
        <div style="margin-top: var(--space-xl)">
            ${renderAnomalousTrips()}
        </div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
}

function openAddUserModal() {
    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-user">
            <div class="modal-content">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2>Add New User</h2>
                    <button onclick="closeModal('modal-add-user')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div class="form-group">
                    <label class="label">Full Name</label>
                    <input type="text" id="new-user-name" class="input" placeholder="e.g. John Mechanic">
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">PHONE NUMBER *</label>
                        <div style="display:flex; flex-direction:row; gap:8px; align-items:center;">
                            <span style="background:rgba(255,255,255,0.05); border:1px solid var(--border); border-radius:var(--radius-md); padding:0 16px; height:56px; display:flex; align-items:center; color:var(--text-main); font-weight:600; font-size:1rem; white-space:nowrap; flex-shrink:0;">+91</span>
                            <input type="tel" id="new-user-phone" placeholder="9876543210" maxlength="10"
                                style="flex:1; min-width:0; height:56px; padding:0 1rem; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-main); font-family:inherit; font-size:1rem; outline:none;">
                        </div>
                        <span style="font-size:0.8rem; color:var(--text-muted); margin-top:6px; display:block;">Enter 10-digit mobile number</span>
                    </div>
                    <div class="form-group">
                        <label class="label">Email (Optional)</label>
                        <input type="email" id="new-user-email" class="input" placeholder="e.g. user@redrivo.com">
                    </div>
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">Role</label>
                        <select id="new-user-role" class="select">
                            <option value="mechanic">Mechanic</option>
                            <option value="marshal">Driver</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="label">Password</label>
                        <input type="password" id="new-user-pass" class="input" placeholder="Set password">
                    </div>
                </div>

                <div class="form-group">
                    <label class="label">Pincode (Required for Driver)</label>
                    <input type="text" id="new-user-pincode" class="input" placeholder="e.g. 411038" maxlength="6">
                </div>

                <div style="text-align: right; margin-top: var(--space-xl)">
                    <button onclick="saveNewUser()" class="btn btn-primary">Save User</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

async function saveNewUser() {
    const name = document.getElementById('new-user-name').value;
    const phoneRaw = document.getElementById('new-user-phone').value.trim();
    const phone = phoneRaw ? '+91' + phoneRaw : '';
    const email = document.getElementById('new-user-email').value;
    const role = document.getElementById('new-user-role').value;
    const password = document.getElementById('new-user-pass').value;
    const pincode = document.getElementById('new-user-pincode').value.trim();

    if (!name || !phone || !password) {
        alert('Name, Phone and Password are required');
        return;
    }

    try {
        await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'u_' + Date.now(),
                name, phone, email, role, password,
                status: 'active',
                pincode
            })
        });

        await fetchRealtimeData();
        closeModal('modal-add-user');
        renderAdmin(document.getElementById('app'));
    } catch (err) {
        alert('Error saving user: ' + err.message);
    }
}

function openAddGarageModal() {
    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-garage">
            <div class="modal-content" style="max-width: 600px">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2>Onboard Partner Garage</h2>
                    <button onclick="closeModal('modal-add-garage')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">Garage Name</label>
                        <input type="text" id="new-gar-name" class="input" placeholder="e.g. Star Motors">
                    </div>
                    <div class="form-group">
                        <label class="label">Owner Name</label>
                        <input type="text" id="new-gar-owner" class="input" placeholder="e.g. Amit Singh">
                    </div>
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">PHONE NUMBER *</label>
                        <div style="display:flex; flex-direction:row; gap:8px; align-items:center;">
                            <span style="background:rgba(255,255,255,0.05); border:1px solid var(--border); border-radius:var(--radius-md); padding:0 16px; height:56px; display:flex; align-items:center; color:var(--text-main); font-weight:600; font-size:1rem; white-space:nowrap; flex-shrink:0;">+91</span>
                            <input type="tel" id="new-gar-phone" placeholder="9876543210" maxlength="10"
                                style="flex:1; min-width:0; height:56px; padding:0 1rem; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-main); font-family:inherit; font-size:1rem; outline:none;">
                        </div>
                        <span style="font-size:0.8rem; color:var(--text-muted); margin-top:6px; display:block;">Enter 10-digit mobile number</span>
                    </div>
                    <div class="form-group">
                        <label class="label">Location (City/Area)</label>
                        <input type="text" id="new-gar-loc" class="input" placeholder="e.g. Pune, Kothrud">
                    </div>
                </div>

                <div class="form-group">
                    <label class="label">Google Maps Link</label>
                    <input type="url" id="new-gar-map" class="input" placeholder="https://goo.gl/maps/...">
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">Garage Type</label>
                        <select id="new-gar-type" class="select">
                            <option value="Standard">Standard</option>
                            <option value="Premium">Premium</option>
                            <option value="Authorized">Authorized</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="label">Initial Commission (%)</label>
                        <input type="number" id="new-gar-comm" class="input" value="10">
                    </div>
                </div>

                <div style="text-align: right; margin-top: var(--space-xl)">
                    <button onclick="saveNewGarage()" class="btn btn-primary">Onboard Garage</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

async function saveNewGarage() {
    const name = document.getElementById('new-gar-name').value;
    const owner = document.getElementById('new-gar-owner').value;
    const phoneRaw = document.getElementById('new-gar-phone').value.trim();
    // Prevent double +91 if user accidentally typed it
    const phone = phoneRaw ? (phoneRaw.startsWith('+91') ? phoneRaw : '+91' + phoneRaw) : '';
    const location = document.getElementById('new-gar-loc').value;
    const gmapLink = document.getElementById('new-gar-map').value;
    const type = document.getElementById('new-gar-type').value;
    const commissionRate = document.getElementById('new-gar-comm').value;

    if (!name || !phone) {
        alert('Garage Name and Contact Number are required');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/garages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'g_' + Date.now(),
                name, owner, phone, location, gmapLink, type, commissionRate,
                joinedDate: new Date().toISOString()
            })
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error || 'Failed to onboard garage due to a server error.');
        }

        await fetchRealtimeData();
        closeModal('modal-add-garage');
        router.navigate('garages');
        
        // Optional: show a success toast or alert
        // alert('Garage partnered successfully!');
    } catch (err) {
        alert('Error onboarding garage: ' + err.message);
    }
}


function renderCRM(container) {
    const html = `
        <div class="fade-in">
            <header class="page-header">
                <div>
                    <h1 class="page-title">Executive CRM</h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">Customer lifecycle and relationship management</p>
                </div>
                <div style="display:flex; gap: 12px;">
                    <button class="btn btn-primary" onclick="openAddCustomerModal()">
                        <i data-lucide="plus"></i> Add Relationship
                    </button>
                </div>
            </header>

            <div class="grid-3" style="align-items: flex-start;">
                <div class="card" style="padding: 0; position: sticky; top: 20px;">
                    <div style="padding: 20px; border-bottom: 1px solid var(--border);">
                        <div class="search-box" style="margin-bottom: 15px;">
                            <i data-lucide="search" style="width:14px; color:var(--text-muted)"></i>
                            <input type="text" placeholder="Search relationships..." class="search-input" oninput="filterCustomerList(this.value)">
                        </div>
                        <div style="display:flex; gap: 10px;">
                            <button class="btn btn-secondary btn-sm active" style="flex:1" onclick="updateCRMFilter('all', this)">All</button>
                            <button class="btn btn-secondary btn-sm" style="flex:1" onclick="updateCRMFilter('customer', this)">Active</button>
                            <button class="btn btn-secondary btn-sm" style="flex:1" onclick="updateCRMFilter('prospect', this)">Prospects</button>
                        </div>
                    </div>
                    <div id="customer-list-v2" style="max-height: 70vh; overflow-y: auto; padding: 10px;">
                        ${renderCustomerListV2()}
                    </div>
                </div>

                <div class="card" style="grid-column: span 2; min-height: 600px;">
                    <div id="customer-details">
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height: 500px; color: var(--text-dim); opacity: 0.5;">
                            <i data-lucide="users" style="width:48px; height:48px; margin-bottom: 20px;"></i>
                            <p style="font-weight: 500;">Select a customer to view comprehensive profile</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
}

let crmSearchQuery = '';
let crmFilterType = 'all';

function updateCRMFilter(type, btn) {
    crmFilterType = type;
    const parent = btn.parentElement;
    parent.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('customer-list-v2').innerHTML = renderCustomerListV2();
}

function filterCustomerList(query) {
    crmSearchQuery = query.toLowerCase();
    document.getElementById('customer-list-v2').innerHTML = renderCustomerListV2();
}

function renderCustomerListV2() {
    const list = PROTOTYPE_STATE.customers.filter(c => {
        const matchesQuery = (c.name || '').toLowerCase().includes(crmSearchQuery) || (c.phone || '').includes(crmSearchQuery);
        if (!matchesQuery) return false;

        const hasRequest = (PROTOTYPE_STATE.serviceRequests || []).some(r => String(r.customerId || r.customerid) === String(c.id));
        const customerType = hasRequest ? 'Active' : 'Prospect';

        if (crmFilterType === 'all') return true;
        if (crmFilterType === 'prospect') return customerType === 'Prospect';
        return customerType === 'Active';
    });

    if (list.length === 0) return '<div style="padding: 40px; text-align:center; color: var(--text-dim); font-size: 0.9rem;">No records found matching criteria.</div>';

    return list.map(c => {
        const hasRequest = (PROTOTYPE_STATE.serviceRequests || []).some(r => String(r.customerId || r.customerid) === String(c.id));
        const isProspect = !hasRequest;
        return `
        <div class="customer-item" onclick="selectCustomer('${c.id}')" id="cust-item-${c.id}">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <div style="font-weight: 600; color: var(--text-main);">${c.name}</div>
                <span class="chip ${isProspect ? 'chip-info' : (c.phoneVerified ? 'chip-success' : 'chip-warning')}" style="font-size: 0.65rem; padding: 2px 6px;">
                    ${isProspect ? 'PROSPECT' : 'ACTIVE'}
                </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-dim); display:flex; align-items:center; gap: 4px;">
                <i data-lucide="phone" style="width:12px"></i> ${c.phone}
            </div>
        </div>
        `;
    }).join('');
}

function selectCustomer(id) {
    const customer = PROTOTYPE_STATE.customers.find(c => c.id === id);
    if (!customer) return;

    const vehicles = PROTOTYPE_STATE.vehicles.filter(v => v.customerId === id);

    const html = `
        <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
            <div style="flex:1">
                <h2>${customer.name} ${customer.type === 'Prospect' ? '<span class="badge badge-info">Prospect</span>' : ''}</h2>
                <div style="color: var(--text-muted); margin-top: 5px">
                    <div style="display:flex; align-items:center; gap: 10px; margin-bottom: 5px">
                        <span><i data-lucide="phone" style="width:14px"></i> ${customer.phone}</span>
                        ${customer.phoneVerified ?
            '<span class="badge badge-success" style="font-size:0.7em">Verified</span>' :
            `<button onclick="verifyExistingContact('${customer.id}', 'phone')" class="btn btn-warning" style="font-size:0.7em; padding: 2px 8px; font-weight:bold">Verify Now</button>`
        }
                    </div>
                    <div style="display:flex; align-items:center; gap: 10px">
                        <span><i data-lucide="mail" style="width:14px"></i> ${customer.email}</span>
                        ${customer.emailVerified ?
            '<span class="badge badge-success" style="font-size:0.7em">Verified</span>' :
            `<button onclick="verifyExistingContact('${customer.id}', 'email')" class="btn btn-warning" style="font-size:0.7em; padding: 2px 8px; font-weight:bold">Verify Now</button>`
        }
                    </div>
                    ${customer.source ? `<div style="margin-top:5px; font-size:0.9rem">Source: <strong>${customer.source}</strong></div>` : ''}
                    ${customer.address ? `<div style="margin-top:5px; font-size:0.9rem">Address: ${customer.address}</div>` : ''}
                </div>
            </div>
            <div style="display:flex; flex-direction: column; gap: 8px;">
                <button onclick="openAddVehicleModal('${customer.id}')" class="btn btn-secondary">
                    <i data-lucide="car"></i> Add Vehicle
                </button>
                <button onclick="router.navigate('survey'); setTimeout(() => renderSurveyWizard(document.getElementById('app'), PROTOTYPE_STATE.customers.find(c => c.id === '${customer.id}')), 100)" class="btn btn-warning">
                    <i data-lucide="clipboard-list"></i> Record Survey
                </button>
            </div>
        </div>
        
        <h3>Vehicles</h3>
        <div class="grid-2" style="margin-top: var(--space-md)">
            ${vehicles.map(v => `
                <div class="card" style="margin-bottom: 0">
                    <div style="display:flex; justify-content:space-between">
                        <span style="font-weight: 600">${v.makeModel}</span>
                        <span class="badge badge-primary">${v.type}</span>
                    </div>
                    ${v.photo ? `<img src="${v.photo}" style="width:100%; height:150px; object-fit:cover; border-radius:var(--radius-md); margin-top:10px" />` : ''}
                    <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 5px">${v.regNumber}</div>
                    <div style="margin-top: var(--space-md)">
                        <button onclick="router.navigate('survey'); setTimeout(() => prefillSurvey('${customer.id}', '${v.id}'), 100)" class="btn btn-primary" style="font-size: 0.8rem; width: 100%">
                            Start Inspection
                        </button>
                    </div>
                </div>
            `).join('')}
             ${vehicles.length === 0 ? '<div style="color: var(--text-muted)">No vehicles added.</div>' : ''}
        </div>
    `;
    document.getElementById('customer-details').innerHTML = html;
    lucide.createIcons();
}

async function verifyExistingContact(customerId, type) {
    const customer = PROTOTYPE_STATE.customers.find(c => c.id === customerId);
    const value = type === 'phone' ? customer.phone : customer.email;

    if (!value) return;

    await showAlert('OTP Sent', `OTP Sent to ${value}: 1234`);
    const otp = await window.customShowPrompt('Enter OTP:');

    if (otp === '1234') {
        if (type === 'phone') customer.phoneVerified = true;
        if (type === 'email') customer.emailVerified = true;
        saveState();
        selectCustomer(customerId); // Refresh view
        await showAlert('Success', 'Verified Successfully!', 'OK', 'success');
    } else {
        await showAlert('Error', 'Incorrect OTP', 'OK', 'danger');
    }
}


function renderSurvey(container) {
    // We need to select customer and vehicle first if not already selected
    const customers = PROTOTYPE_STATE.customers;

    const html = `
        <div class="header">
            <h1 class="page-title">Vehicle Inspection Survey</h1>
        </div>
        
        <div class="card" id="survey-selector">
            <div class="grid-2">
                <div class="form-group">
                    <label class="label">Select Customer</label>
                    <select id="survey-customer-select" class="select" onchange="surveyCustomerChanged()">
                        <option value="">-- Select Customer --</option>
                        ${customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="label">Select Vehicle</label>
                    <select id="survey-vehicle-select" class="select" disabled onchange="surveyVehicleChanged()">
                        <option value="">-- Select Vehicle First --</option>
                    </select>
                </div>
            </div>
        </div>
        
        <div id="survey-form-container" style="display:none">
            <!-- Dynamic Survey Form -->
        </div>
    `;
    container.innerHTML = html;
}

function surveyCustomerChanged() {
    const customerId = document.getElementById('survey-customer-select').value;
    const vehicleSelect = document.getElementById('survey-vehicle-select');

    vehicleSelect.innerHTML = '<option value="">-- Select Vehicle --</option>';
    vehicleSelect.disabled = true;
    document.getElementById('survey-form-container').style.display = 'none';

    if (customerId) {
        const vehicles = PROTOTYPE_STATE.vehicles.filter(v => v.customerId === customerId);
        vehicles.forEach(v => {
            vehicleSelect.innerHTML += `<option value="${v.id}" data-type="${v.type}">${v.makeModel} (${v.regNumber})</option>`;
        });
        vehicleSelect.disabled = false;
    }
}

function surveyVehicleChanged() {
    const vehicleSelect = document.getElementById('survey-vehicle-select');
    const vehicleId = vehicleSelect.value;
    if (!vehicleId) return;

    const vehicleType = vehicleSelect.options[vehicleSelect.selectedIndex].getAttribute('data-type'); // Car or Bike

    // Safety check for data
    if (!MASTER_DATA[vehicleType]) {
        alert(`Master data not found for vehicle type: ${vehicleType}`);
        return;
    }

    renderSurveyForm(vehicleType, vehicleId);
}

function renderSurveyForm(type, vehicleId) {
    const container = document.getElementById('survey-form-container');
    const data = MASTER_DATA[type]; // Hierarchical data
    const categories = Object.keys(data);

    let html = `
        <div class="card" style="border-top: 4px solid var(--primary)">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: var(--space-lg)">
                <h2>Inspection Checklist (500 Points)</h2>
                <div style="background: var(--bg-surface); padding: 20px; border-radius: 12px; border: 1px solid var(--border); min-width: 250px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                        <span style="color: var(--text-muted)">Subtotal: </span>
                        <span style="font-weight: 600" id="subtotal-estimate">₹0</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                        <span style="color: var(--text-muted)">GST (18%): </span>
                        <span style="font-weight: 600" id="gst-estimate">₹0</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; padding-top: 8px; border-top: 1px solid var(--border);">
                        <span style="font-size: 1.1rem; font-weight: 700">Total Price: </span>
                        <span style="font-size: 1.5rem; font-weight: 700; color: var(--primary)" id="total-estimate">₹0</span>
                    </div>
                </div>
            </div>
            
            <div class="inspection-list-vertical">
    `;

    categories.forEach(cat => {
        html += `
            <div class="inspection-category-header" style="background: var(--bg-surface); padding: 12px 20px; margin: 20px 0 10px 0; border-radius: 8px; border-left: 4px solid var(--primary); font-weight: 700; display: flex; align-items: center; gap: 10px;">
                <i data-lucide="layers" style="width: 18px; height: 18px"></i>
                ${cat}
            </div>
        `;

        data[cat].forEach((item, idx) => {
            const inputId = `item-${cat.replace(/\s/g, '')}-${idx}`;

            html += `
                <div class="inspection-item-vertical" style="display: grid; grid-template-columns: 2fr 1.5fr 1fr 1fr 1fr 1.2fr; gap: 15px; padding: 15px 20px; border-bottom: 1px solid var(--border); align-items: center;">
                    <div class="item-name" style="font-weight: 600; font-size: 0.95rem;">${item.name}</div>
                    
                    <div class="item-condition">
                        <select class="select" id="${inputId}" onchange="updateSurveyItem(this)"
                                data-item-name="${item.name}" data-category="${cat}" style="width: 100%; height: 40px; font-size: 0.85rem;">
                            ${item.conditions.map(c => `
                                <option value="${c.name}" data-status="${c.status}" data-garage="${c.garageCost}"
                                        data-comm="${c.commission}" data-our="${c.ourCost}" data-priority="${c.priority}">
                                    ${c.name}
                                </option>
                            `).join('')}
                        </select>
                        <div id="${inputId}-serial-container" style="display:none; margin-top:8px;">
                            <div style="display:flex; gap:8px; margin-bottom:8px;">
                                <input type="text" id="${inputId}-serial" placeholder="Enter Part Serial..." class="input" style="height:34px; font-size:0.75rem;">
                                <button onclick="validateSerialForSurvey('${inputId}')" class="btn btn-primary" style="padding:4px 8px; font-size:0.7rem;">Verify</button>
                            </div>
                            <div id="${inputId}-serial-status" style="font-size:0.65rem; margin-top:4px; display:none; margin-bottom:8px;"></div>
                            
                            <div style="border:1px dashed var(--border); border-radius:6px; padding:8px; text-align:center; position:relative; overflow:hidden; background:rgba(255,255,255,0.02);">
                                <input type="file" id="${inputId}-photo" accept="image/*" style="display:none;" onchange="handleSurveyPhotoUpload('${inputId}', this)">
                                <div id="${inputId}-photo-preview" style="display:none; width:100%; height:60px; object-fit:cover; border-radius:4px; margin-bottom:5px; border:1px solid var(--border);"></div>
                                <button onclick="document.getElementById('${inputId}-photo').click()" class="btn btn-secondary btn-sm" style="width:100%; font-size:0.65rem; padding:4px;">
                                    <i data-lucide="camera" style="width:12px; height:12px; margin-right:4px;"></i> Upload Part Photo
                                </button>
                                <div style="font-size:0.5rem; color:var(--text-dim); margin-top:4px;">Required for Replacement</div>
                            </div>
                        </div>
                    </div>

                    <div class="item-garage-cost">
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 4px;">Garage ₹</div>
                        <input type="number" class="input" id="${inputId}-garage-override" oninput="calculateItemPrice('${inputId}')" style="height: 35px; padding: 0 8px; font-size: 0.85rem;" />
                    </div>

                    <div class="item-comm">
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 4px;">Comm %</div>
                        <input type="number" class="input" id="${inputId}-comm-override" oninput="calculateItemPrice('${inputId}')" style="height: 35px; padding: 0 8px; font-size: 0.85rem;" />
                    </div>

                    <div class="item-status" style="text-align: center;">
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 4px;">Status</div>
                        <span class="badge" id="${inputId}-status" style="display: inline-block; width: 80px; text-align: center;">--</span>
                    </div>

                    <div class="item-total" style="text-align: right;">
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 4px;">Total ₹</div>
                        <span style="font-weight: 700; color: var(--text-main); font-size: 1.1rem;" id="${inputId}-cost">₹0</span>
                    </div>
                </div>
            `;
        });
    });

    html += `</div>`;

    html += `
        <div style="margin-top: var(--space-xl); text-align: right; display: flex; gap: 15px; justify-content: flex-end;">
            <button onclick="router.navigate('survey')" class="btn btn-secondary">Cancel</button>
            <button onclick="submitServiceRequest('${vehicleId}')" class="btn btn-primary" style="padding: 12px 32px; font-size: 1.1rem; box-shadow: 0 4px 15px rgba(255, 62, 5, 0.3);">
                <i data-lucide="save"></i> Generate Service Request
            </button>
        </div>
    </div>`;

    container.innerHTML = html;
    container.style.display = 'block';

    // Trigger initial updates for all selects to set default values
    setTimeout(() => {
        container.querySelectorAll('select').forEach(select => {
            updateSurveyItem(select);
        });
    }, 100);

    lucide.createIcons();
}

function updateSurveyItem(selectEl) {
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    const status = selectedOption.getAttribute('data-status');
    const garageCost = selectedOption.getAttribute('data-garage');
    const comm = selectedOption.getAttribute('data-comm');
    const priority = selectedOption.getAttribute('data-priority');

    const inputId = selectEl.id;

    // Show/Hide serial & photo container
    const serialContainer = document.getElementById(`${inputId}-serial-container`);
    if (status === 'Replace') {
        serialContainer.style.display = 'block';
    } else {
        serialContainer.style.display = 'none';
        document.getElementById(`${inputId}-serial`).value = '';
        document.getElementById(`${inputId}-serial-status`).style.display = 'none';
        document.getElementById(`${inputId}-photo`).value = '';
        document.getElementById(`${inputId}-photo-preview`).style.display = 'none';
    }

    // Set defaults in override inputs
    document.getElementById(`${inputId}-garage-override`).value = garageCost;
    document.getElementById(`${inputId}-comm-override`).value = comm;

    // Update Badge
    const statusBadge = document.getElementById(`${inputId}-status`);
    statusBadge.textContent = status;
    statusBadge.className = 'badge';

    if (status === 'Replace') statusBadge.classList.add('badge-danger');
    else if (status === 'Monitor') statusBadge.classList.add('badge-warning');
    else if (status === 'Not Required') statusBadge.classList.add('badge-success');

    // Calculate Price
    calculateItemPrice(inputId);
}

async function validateSerialForSurvey(inputId) {
    const serialNum = document.getElementById(`${inputId}-serial`).value.trim();
    const statusEl = document.getElementById(`${inputId}-serial-status`);
    const garageId = document.getElementById('survey-garage-select')?.value || PROTOTYPE_STATE.currentUser?.garageId;

    if (!serialNum) return alert('Enter a serial number');
    if (!garageId) return alert('Select a garage first');

    statusEl.style.display = 'block';
    statusEl.textContent = 'Verifying...';
    statusEl.style.color = 'var(--info)';

    try {
        const res = await fetch(`${API_URL}/validate-part`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serialNumber: serialNum, garageId })
        });
        const data = await res.json();

        if (data.valid) {
            statusEl.textContent = `✓ Genuine: ${data.part.itemName}`;
            statusEl.style.color = 'var(--success)';
            document.getElementById(`${inputId}-serial`).setAttribute('data-valid', 'true');
            document.getElementById(`${inputId}-serial`).setAttribute('data-sku-id', data.part.skuId);
        } else {
            statusEl.textContent = `✕ ${data.reason}`;
            statusEl.style.color = 'var(--danger)';
            document.getElementById(`${inputId}-serial`).setAttribute('data-valid', 'false');
        }
    } catch (err) {
        statusEl.textContent = '✕ Connection Error';
        statusEl.style.color = 'var(--danger)';
    }
}

function handleSurveyPhotoUpload(inputId, input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        const preview = document.getElementById(`${inputId}-photo-preview`);
        const reader = new FileReader();
        
        reader.onload = function(e) {
            preview.style.display = 'block';
            preview.style.backgroundImage = `url(${e.target.result})`;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
            document.getElementById(`${inputId}-photo`).setAttribute('data-base64', e.target.result);
        };
        reader.readAsDataURL(file);
    }
}

function calculateItemPrice(inputId) {
    const garageCost = parseFloat(document.getElementById(`${inputId}-garage-override`).value) || 0;
    const comm = parseFloat(document.getElementById(`${inputId}-comm-override`).value) || 0;

    // Final Cost to Customer = Garage Cost + Commission%
    const finalCost = Math.round(garageCost * (1 + (comm / 100)));

    document.getElementById(`${inputId}-cost`).textContent = `₹${finalCost}`;

    // Update Total
    updateTotalEstimate();
}



function updateTotalEstimate() {
    let subtotal = 0;
    document.querySelectorAll('[id$="-cost"]').forEach(el => {
        subtotal += parseInt(el.textContent.replace('₹', ''));
    });

    const gst = Math.round(subtotal * 0.18);
    const total = subtotal + gst;

    document.getElementById('subtotal-estimate').textContent = `₹${subtotal.toLocaleString()}`;
    document.getElementById('gst-estimate').textContent = `₹${gst.toLocaleString()}`;
    document.getElementById('total-estimate').textContent = `₹${total.toLocaleString()}`;
}

async function submitServiceRequest(vehicleId) {
    const customerId = document.getElementById('survey-customer-select').value;
    const items = [];
    let subtotal = 0;

    document.querySelectorAll('#survey-form-container select').forEach(select => {
        const selectedOption = select.options[select.selectedIndex];
        const status = selectedOption.getAttribute('data-status');

        if (status !== 'Not Required') {
            const inputId = select.id;
            
            // Check Serial & Photo if Replace
            let serialNum = '';
            let partPhoto = '';
            if (status === 'Replace') {
                const serialInput = document.getElementById(`${inputId}-serial`);
                if (serialInput.getAttribute('data-valid') !== 'true') {
                    throw new Error(`Please verify a genuine serial number for ${select.getAttribute('data-item-name')}`);
                }
                serialNum = serialInput.value.trim();

                const photoInput = document.getElementById(`${inputId}-photo`);
                partPhoto = photoInput.getAttribute('data-base64');
                if (!partPhoto) {
                    throw new Error(`Please upload a photo for replaced part: ${select.getAttribute('data-item-name')}`);
                }
            }

            const garageCost = parseFloat(document.getElementById(`${inputId}-garage-override`).value) || 0;
            const commission = parseFloat(document.getElementById(`${inputId}-comm-override`).value) || 0;
            const ourCost = Math.round(garageCost * (1 + (commission / 100)));

            items.push({
                category: select.getAttribute('data-category'),
                item: select.getAttribute('data-item-name'),
                condition: selectedOption.value,
                status: status,
                serialNumber: serialNum,
                photo: partPhoto,
                garageCost: garageCost,
                commission: commission,
                ourCost: ourCost,
                priority: selectedOption.getAttribute('data-priority')
            });
            subtotal += ourCost;
        }
    });

    const gstAmount = Math.round(subtotal * 0.18);
    const totalCustomerPrice = subtotal + gstAmount;

    try {
        await fetch(`${API_URL}/requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: generateId(),
                customerId: customerId,
                vehicleId: vehicleId,
                date: new Date().toISOString(),
                status: 'Open',
                serviceType: 'Manual Checkup', // CRM created usually manual
                pickupDropType: 'None',
                pickupDropCost: 0,
                garageServiceCharge: subtotal,
                commissionPercent: 10, // Default for CRM
                commissionAmount: Math.round(subtotal * 0.1),
                gstAmount: gstAmount,
                totalCustomerPrice: totalCustomerPrice,
                issue: `CRM Created Request via 250-point Checklist. Items: ${JSON.stringify(items)}`
            })
        });

        await fetchRealtimeData();
        alert('Service Request Generated Successfully!');
        router.navigate('requests');
    } catch (err) {
        alert('Error saving service request: ' + err.message);
    }
}

function renderRequests(container) {
    const requests = [...PROTOTYPE_STATE.serviceRequests]
        .reverse()
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    const html = `
        <div class="fade-in">
            <header class="page-header">
                <div>
                    <h1 class="page-title">Service Pipeline</h1>
                    <p style="color: var(--text-dim); margin-top: 4px;">Real-time order management and fulfillment</p>
                </div>
                <div style="display:flex; gap: 12px;">
                    <div class="search-box">
                        <i data-lucide="search" style="width:16px; color:var(--text-muted)"></i>
                        <input type="text" placeholder="Search orders..." class="search-input" id="order-search" oninput="filterOrders()">
                    </div>
                    <button class="btn btn-secondary" onclick="fetchRealtimeData().then(() => renderRequests(document.getElementById('app')))">
                        <i data-lucide="refresh-cw"></i>
                    </button>
                </div>
            </header>

            <div class="card" style="padding: 0; overflow: hidden;">
                <div style="padding: 15px 25px; background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--border); display:flex; gap: 20px;">
                    <button class="tab-btn active">All Orders (${requests.length})</button>
                    <button class="tab-btn">In Progress</button>
                    <button class="tab-btn">Completed</button>
                </div>
                
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Order ID</th>
                            <th>Customer & Vehicle</th>
                            <th>Pincode</th>
                            <th>Fulfillment Point</th>
                            <th>Status</th>
                            <th style="text-align:right">Total Payable</th>
                            <th style="text-align:center">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="orders-tbody">
                        ${requests.map(req => {
                            const flow = req.booking_flow || req.bookingFlow || '';
                            let fulfillmentIcon = 'warehouse';
                            let fulfillmentColor = 'var(--text-muted)';
                            let fulfillmentText = 'Unassigned';

                            if (flow === 'p2p') {
                                fulfillmentIcon = 'map-pin';
                                fulfillmentColor = 'var(--info)';
                                fulfillmentText = req.pickup_address ? req.pickup_address.split(',')[0].trim() : 'Direct Pickup';
                            } else if (flow === 'rental_p2p') {
                                fulfillmentIcon = 'key';
                                fulfillmentColor = 'var(--warning)';
                                fulfillmentText = req.pickup_address ? req.pickup_address.split('(')[0].trim() : 'Rental Hub';
                            } else {
                                const actualGarageId = req.assignedGarageId || req.garageid;
                                const assignedGarage = actualGarageId ? PROTOTYPE_STATE.garages.find(g => g.id === actualGarageId) : null;
                                if (assignedGarage) {
                                    fulfillmentIcon = 'warehouse';
                                    fulfillmentColor = 'var(--success)';
                                    fulfillmentText = assignedGarage.name;
                                }
                            }
                            
                            const actualCustId = req.customerId || req.customerid;
                            const cust = PROTOTYPE_STATE.customers.find(c => c.id === actualCustId);
                            const customerName = cust ? cust.name : (req.customerName || req.customername || 'Walk-in');
                            
                            const actualVehId = req.vehicleId || req.vehicleid;
                            const veh = PROTOTYPE_STATE.vehicles.find(v => v.id === actualVehId);
                            const vehicleName = veh ? `${veh.make} ${veh.model}` : (req.vehicleName || req.vehiclename || 'Unknown Vehicle');
                            
                            const displayPincode = req.pincode || (req.pickup_address ? (req.pickup_address.match(/\b\d{6}\b/) || ['N/A'])[0] : 'N/A');

                            return `
                            <tr>
                                <td>
                                    <div style="font-family: monospace; font-weight:700; color:var(--primary)">#${req.id.substring(0, 8)}</div>
                                    <div style="font-size: 0.75rem; color:var(--text-dim); margin-top:2px">${new Date(req.date).toLocaleDateString()}</div>
                                </td>
                                <td>
                                    <div style="font-weight:600">${customerName}</div>
                                    <div style="font-size: 0.8rem; color:var(--text-muted)">${vehicleName}</div>
                                </td>
                                <td>
                                    <div style="font-weight:600; color:var(--text-main); font-family:monospace;">${displayPincode}</div>
                                </td>
                                <td>
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <i data-lucide="${fulfillmentIcon}" style="width:14px; color:${fulfillmentColor}"></i>
                                        <span style="font-size:0.85rem; font-weight:500">${fulfillmentText}</span>
                                    </div>
                                </td>
                                <td>
                                    <span class="chip ${req.status === 'completed' ? 'chip-success' : 'chip-warning'}">${req.status}</span>
                                </td>
                                <td style="text-align:right; font-weight:700; font-size:1rem;">
                                    ₹${(req.totalCustomerPrice || 0).toLocaleString()}
                                </td>
                                <td>
                                    <div style="display:flex; justify-content:center; gap:8px;">
                                        <button class="btn btn-secondary btn-sm" onclick="openRequestDetailsModal('${req.id}')" title="View Details">
                                            <i data-lucide="eye" style="width:14px"></i>
                                        </button>
                                        ${PROTOTYPE_STATE.currentUser.role === 'Admin' ? `
                                            <button class="btn btn-secondary btn-sm" onclick="openAssignGarageModal('${req.id}')" title="Assign Garage">
                                                <i data-lucide="user-plus" style="width:14px"></i>
                                            </button>
                                            <button class="btn btn-secondary btn-sm" onclick="deleteServiceRequest('${req.id}')" style="color:var(--danger)" title="Delete">
                                                <i data-lucide="trash-2" style="width:14px"></i>
                                            </button>
                                        ` : ''}
                                    </div>
                                </td>
                            </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
                ${requests.length === 0 ? '<div style="padding: 60px; text-align:center; color: var(--text-dim);">No active orders found in the pipeline.</div>' : ''}
            </div>
        </div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
}

function openRequestDetailsModal(requestId) {
    const req = PROTOTYPE_STATE.serviceRequests.find(r => r.id === requestId);
    if (!req) return;

    const flow = req.booking_flow || req.bookingFlow || '';
    let flowTitle = 'Garage Booking';
    let flowDetails = '';
    
    if (flow === 'p2p') {
        flowTitle = 'Point-to-Point Transit';
        flowDetails = `
            <div style="margin-top: 5px; color: var(--info)">
                <strong>Booking Type:</strong> ${flowTitle}<br>
                <strong>Route:</strong> ${req.pickup_address || 'N/A'} → ${req.drop_address || 'N/A'}
            </div>
        `;
    } else if (flow === 'rental_p2p') {
        flowTitle = 'Rental Fleet Booking';
        const hubName = req.pickup_address ? req.pickup_address.split('(')[0].trim() : 'Rental Hub';
        flowDetails = `
            <div style="margin-top: 5px; color: var(--warning)">
                <strong>Booking Type:</strong> ${flowTitle}<br>
                <strong>Pickup Hub:</strong> ${hubName}<br>
                <strong>Delivery Address:</strong> ${req.drop_address || 'N/A'}
            </div>
        `;
    } else {
        const actualGarageId = req.assignedGarageId || req.garageid;
        const assignedGarage = actualGarageId ? PROTOTYPE_STATE.garages.find(g => g.id === actualGarageId) : null;
        flowDetails = assignedGarage ? `
            <div style="margin-top: 5px; color: var(--success)">
                <strong>Booking Type:</strong> Garage Service<br>
                <strong>Assigned Garage:</strong> ${assignedGarage.name}
            </div>
        ` : `
            <div style="margin-top: 5px; color: var(--text-muted)">
                <strong>Booking Type:</strong> Garage Service (Unassigned)
            </div>
        `;
    }
    
    const actualCustId = req.customerId || req.customerid;
    const cust = PROTOTYPE_STATE.customers.find(c => c.id === actualCustId);
    const customerName = cust ? cust.name : (req.customerName || req.customername || 'Walk-in');
    
    const actualVehId = req.vehicleId || req.vehicleid;
    const veh = PROTOTYPE_STATE.vehicles.find(v => v.id === actualVehId);
    const vehicleName = veh ? `${veh.make} ${veh.model}` : (req.vehicleName || req.vehiclename || 'Unknown Vehicle');

    const modalHtml = `
        <div class="modal-overlay open" id="modal-request-details">
            <div class="modal-content" style="max-width: 600px; width: 90%">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2>Request Details #${req.id}</h2>
                    <button onclick="closeModal('modal-request-details')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div style="margin-bottom: 20px">
                    <div style="font-weight: 600; font-size: 1.1rem">${customerName}</div>
                    <div style="color: var(--text-muted)">${vehicleName}</div>
                    <div style="margin-top: 5px; font-size: 0.9rem; color: var(--text-muted)">Date: ${new Date(req.date).toLocaleDateString()}</div>
                    <div style="margin-top: 5px">Status: <span class="badge badge-primary">${req.status}</span></div>
                    ${flowDetails}
                </div>

                <div style="background: var(--bg-surface); padding: var(--space-md); border-radius: var(--radius-md); max-height: 300px; overflow-y: auto; margin-bottom: 15px;">
                    ${req.items.map(item => `
                        <div style="display:flex; justify-content:space-between; font-size: 0.9rem; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px">
                            <div style="flex: 1">
                                <div style="font-weight:500">${item.item}</div>
                                <div style="font-size:0.8rem; color:var(--text-muted)">${item.condition}</div>
                            </div>
                            <div style="text-align:right">
                                <span class="badge ${item.priority === 'P1' ? 'badge-danger' : 'badge-warning'}" style="margin-right: 5px">${item.priority}</span>
                                <div style="font-size: 0.75rem; color: var(--text-muted)">₹${item.garageCost} + ${item.commission}%</div>
                                <div style="font-weight:600">₹${item.ourCost}</div>
                            </div>
                        </div>
                    `).join('')}
                    ${req.items.length === 0 ? '<div style="font-style:italic">No service items.</div>' : ''}
                </div>
                
                <div style="background: rgba(255, 62, 5, 0.05); padding: 15px; border-radius: 8px; border: 1px solid rgba(255, 62, 5, 0.2);">
                    <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                        <span style="color: var(--text-muted)">Service Charge:</span>
                        <span style="font-weight: 600">₹${(req.garageServiceCharge || 0).toLocaleString()}</span>
                    </div>
                    ${req.pickupDropCost ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                        <span style="color: var(--text-muted)">Pickup & Drop:</span>
                        <span style="font-weight: 600">₹${(req.pickupDropCost || 0).toLocaleString()}</span>
                    </div>
                    ` : ''}
                    <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                        <span style="color: var(--text-muted)">GST (18%):</span>
                        <span style="font-weight: 600">₹${(req.gstAmount || 0).toLocaleString()}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,62,5,0.2);">
                        <span style="font-size: 1.1rem; font-weight: 700">Total Payable:</span>
                        <span style="font-size: 1.3rem; font-weight: 700; color: var(--primary)">₹${(req.totalCustomerPrice || 0).toLocaleString()}</span>
                    </div>
                </div>

                <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px">
                    <h3>Service Evidence</h3>
                    <div style="display:flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px; margin-top: 10px">
                        ${(req.evidencePhotos || []).map(photo => `
                            <img src="${photo}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; cursor: pointer; border: 1px solid var(--border)" onclick="window.open(this.src)">
                        `).join('')}
                    </div>
                    <input type="file" id="details-evidence-${req.id}" style="display:none" accept="image/*" onchange="uploadServiceEvidence('${req.id}', this)">
                    <button onclick="document.getElementById('details-evidence-${req.id}').click()" class="btn btn-secondary" style="width:100%">
                        <i data-lucide="camera"></i> Add Photo
                    </button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
    lucide.createIcons();
}


function uploadServiceEvidence(requestId, input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        if (file.size > 2 * 1024 * 1024) {
            alert('File too large (Max 2MB)');
            return;
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            const req = PROTOTYPE_STATE.serviceRequests.find(r => r.id === requestId);
            if (!req.evidencePhotos) req.evidencePhotos = [];
            req.evidencePhotos.push(e.target.result);
            saveState();

            // If details modal is open, refresh it
            const detailsModal = document.getElementById('modal-request-details');
            if (detailsModal) {
                openRequestDetailsModal(requestId);
            }
        };
        reader.readAsDataURL(file);
    }
}



function getGarageName(garageId) {
    const g = PROTOTYPE_STATE.garages.find(g => g.id === garageId);
    return g ? g.name : 'Unknown Garage';
}

async function deleteServiceRequest(id) {
    if (!confirm('Are you sure you want to delete this service request?')) return;

    try {
        await fetch(`${API_URL}/requests/${id}`, { method: 'DELETE' });
        await fetchRealtimeData();
        renderRequests(document.getElementById('app'));
    } catch (err) {
        alert('Error deleting: ' + err.message);
    }
}

let activeRequestIdForAssign = null;

function openAssignGarageModal(requestId) {
    activeRequestIdForAssign = requestId;

    const garages = PROTOTYPE_STATE.garages;

    const modalHtml = `
        <div class="modal-overlay open" id="modal-assign-garage">
            <div class="modal-content">
                <h2>Assign Garage</h2>
                <div class="form-group">
                    <label class="label">Select Garage</label>
                    <select id="assign-garage-select" class="select">
                        <option value="">-- Select Garage --</option>
                        ${garages.map(g => `<option value="${g.id}">${g.name} (${g.location})</option>`).join('')}
                    </select>
                </div>
                <div style="text-align: right; margin-top: 20px">
                     <button onclick="closeModal('modal-assign-garage')" class="btn btn-secondary">Cancel</button>
                     <button onclick="assignGarageToRequest()" class="btn btn-primary">Assign</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

async function assignGarageToRequest() {
    const garageId = document.getElementById('assign-garage-select').value;
    if (!garageId) {
        alert('Please select a garage');
        return;
    }

    try {
        await fetch(`${API_URL}/requests/${activeRequestIdForAssign}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Assigned' }) // Note: we could also add an assignedGarageId endpoint to backend, but status update is working
        });

        // The local DB schema for service_requests doesn't have an assignedGarageId. 
        // We will store it by replacing it loosely or using local metadata if needed. 
        // For a prototype, updating the status to "Assigned" triggers the status bar correctly.

        const req = PROTOTYPE_STATE.serviceRequests.find(r => r.id === activeRequestIdForAssign);
        if (req) {
            req.assignedGarageId = garageId;
            req.assignmentDate = new Date().toISOString();
            // We save this meta info locally since the backend doesn't support assignedGarageId right now in a rush
            localStorage.setItem(`redrivo_req_assign_${req.id}`, garageId);
        }

        await fetchRealtimeData();
        closeModal('modal-assign-garage');
        renderRequests(document.getElementById('app'));
    } catch (err) {
        alert("Error assigning: " + err.message);
    }
}


// --- Constants ---
const CAR_MAKES = [
    "Maruti Suzuki", "Hyundai", "Tata Motors", "Mahindra", "Honda", "Toyota",
    "Kia", "MG Motor", "Renault", "Volkswagen", "Skoda", "Jeep", "Nissan",
    "Citroen", "Audi", "BMW", "Mercedes-Benz", "Volvo", "Jaguar", "Land Rover"
].sort();

const BIKE_MAKES = [
    "Hero MotoCorp", "Honda", "TVS", "Bajaj", "Royal Enfield", "Yamaha",
    "Suzuki", "KTM", "Jawa / Yezdi", "Ather", "Ola Electric", "Revolt",
    "Kawasaki", "Triumph", "Harley-Davidson", "Ducati"
].sort();

// --- Modals ---

const COUNTRY_CODES = [
    { code: '+91', country: 'India' },
    { code: '+1', country: 'USA' },
    { code: '+44', country: 'UK' },
    { code: '+971', country: 'UAE' },
    { code: '+65', country: 'Singapore' }
];

function openAddCustomerModal() {
    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-customer">
            <div class="modal-content">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2>Add New Customer</h2>
                    <button onclick="closeModal('modal-add-customer')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div class="form-group">
                    <label class="label">Full Name</label>
                    <input type="text" id="new-cust-name" class="input" placeholder="e.g. John Doe">
                </div>
                
                <div class="form-group">
                    <label class="label">PHONE NUMBER *</label>
                    <div style="display:flex; flex-direction:row; gap:10px; align-items:flex-start;">
                        <div style="flex:1;">
                            <div style="display:flex; flex-direction:row; gap:8px; align-items:center;">
                                <span style="background:rgba(255,255,255,0.05); border:1px solid var(--border); border-radius:var(--radius-md); padding:0 16px; height:56px; display:flex; align-items:center; color:var(--text-main); font-weight:600; font-size:1rem; white-space:nowrap; flex-shrink:0;">+91</span>
                                <input type="tel" id="new-cust-phone" placeholder="9876543210" maxlength="10" data-verified="false"
                                    style="flex:1; min-width:0; height:56px; padding:0 1rem; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-main); font-family:inherit; font-size:1rem; outline:none;">
                            </div>
                            <span style="font-size:0.8rem; color:var(--text-muted); margin-top:6px; display:block;">Enter 10-digit mobile number</span>
                        </div>
                        <button onclick="verifyContact('phone')" id="btn-verify-phone" class="btn btn-secondary" style="white-space:nowrap; height:56px;">Verify</button>
                    </div>
                </div>
                
                <div class="form-group">
                    <label class="label">Email</label>
                    <div style="display:flex; gap: 10px">
                        <input type="email" id="new-cust-email" class="input" placeholder="e.g. john@example.com" data-verified="false">
                         <button onclick="verifyContact('email')" id="btn-verify-email" class="btn btn-secondary" style="white-space:nowrap">Verify</button>
                    </div>
                </div>
                
                <div style="text-align: right; margin-top: var(--space-xl)">
                    <button onclick="saveNewCustomer()" class="btn btn-primary">Save Customer</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
}

async function verifyContact(type) {
    const inputId = type === 'phone' ? 'new-cust-phone' : 'new-cust-email';
    const btnId = type === 'phone' ? 'btn-verify-phone' : 'btn-verify-email';
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);

    if (!input.value) {
        await showAlert('Error', `Please enter a valid ${type}`, 'OK', 'danger');
        return;
    }

    const valueToVerify = type === 'phone' ? '+91' + input.value : input.value;
    // Simulate OTP
    await showAlert('OTP Sent', `OTP Sent to ${valueToVerify}: 1234`);
    const otp = await window.customShowPrompt('Enter OTP:');

    if (otp === '1234') {
        input.setAttribute('data-verified', 'true');
        input.style.borderColor = 'var(--success)';
        btn.innerText = 'Verified';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
        btn.disabled = true;
    } else {
        await showAlert('Error', 'Incorrect OTP', 'OK', 'danger');
    }
}

async function saveNewCustomer() {
    const name = document.getElementById('new-cust-name').value;
    const phoneRaw = document.getElementById('new-cust-phone').value.trim();
    const phone = phoneRaw ? '+91' + phoneRaw : '';
    const email = document.getElementById('new-cust-email').value;

    const phoneVerified = document.getElementById('new-cust-phone').getAttribute('data-verified') === 'true';
    const emailVerified = document.getElementById('new-cust-email').getAttribute('data-verified') === 'true';

    if (!name || !phone) {
        alert('Name and Phone are required');
        return;
    }

    const newCustomerId = generateId();

    try {
        await fetch(`${API_URL}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: newCustomerId,
                name: name,
                phone: phone,
                email: email,
                phoneVerified: phoneVerified,
                emailVerified: emailVerified
            })
        });

        await fetchRealtimeData();
        closeModal('modal-add-customer');
        renderCRM(document.getElementById('app')); // Refresh
    } catch (err) {
        alert('Error saving customer: ' + err.message);
    }
}


function openAddVehicleModal(customerId) {
    const modalHtml = `
        <div class="modal-overlay open" id="modal-add-vehicle">
            <div class="modal-content">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2>Add Vehicle</h2>
                    <button onclick="closeModal('modal-add-vehicle')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div class="form-group">
                    <label class="label">Vehicle Type</label>
                    <select id="new-veh-type" class="select" onchange="updateMakeList()">
                        <option value="Car">Car</option>
                        <option value="Bike">Bike</option>
                    </select>
                </div>
                
                <div class="grid-2">
                    <div class="form-group">
                        <label class="label">Make (Company)</label>
                        <input type="text" id="new-veh-make" class="input" list="make-list" placeholder="Search or Type...">
                        <datalist id="make-list">
                            <!-- Populated by JS -->
                        </datalist>
                    </div>
                    <div class="form-group">
                        <label class="label">Model</label>
                        <input type="text" id="new-veh-model" class="input" placeholder="e.g. City / Splendor">
                    </div>
                </div>

                <div class="form-group">
                    <label class="label">Registration Number</label>
                    <input type="text" id="new-veh-reg" class="input" placeholder="e.g. MH12AB1234">
                </div>
                <div class="form-group">
                    <label class="label">Vehicle Photo</label>
                    <input type="file" id="new-veh-photo" class="input" accept="image/*">
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px">Optional. Max 2MB recommended.</div>
                </div>
                
                <div style="text-align: right; margin-top: var(--space-xl)">
                    <button onclick="saveNewVehicle('${customerId}')" class="btn btn-primary">Save Vehicle</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
    updateMakeList(); // Initialize functionality
}

function updateMakeList() {
    const type = document.getElementById('new-veh-type').value;
    const datalist = document.getElementById('make-list');
    datalist.innerHTML = '';

    const makes = type === 'Car' ? CAR_MAKES : BIKE_MAKES;
    makes.forEach(make => {
        const option = document.createElement('option');
        option.value = make;
        datalist.appendChild(option);
    });
}

function saveNewVehicle(customerId) {
    const type = document.getElementById('new-veh-type').value;
    const make = document.getElementById('new-veh-make').value;
    const model = document.getElementById('new-veh-model').value;
    const regNumber = document.getElementById('new-veh-reg').value;
    const photoInput = document.getElementById('new-veh-photo');

    if (!make || !model || !regNumber) {
        alert('Make, Model and Registration Number are required');
        return;
    }

    const saveVehicleData = async (base64Photo = null) => {
        try {
            await fetch(`${API_URL}/vehicles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: generateId(),
                    customerId: customerId,
                    plate: regNumber,
                    make: make,
                    model: model,
                    type: type,
                    makeModel: `${make} ${model}`,
                    photo: base64Photo
                })
            });

            await fetchRealtimeData();
            closeModal('modal-add-vehicle');
            selectCustomer(customerId);
        } catch (err) {
            alert('Error saving vehicle: ' + err.message);
        }
    };

    if (photoInput.files && photoInput.files[0]) {
        const file = photoInput.files[0];
        if (file.size > 2 * 1024 * 1024) {
            if (!confirm('This image is large (>2MB) and might fill up local storage. Continue?')) {
                return;
            }
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            saveVehicleData(e.target.result);
        };
        reader.readAsDataURL(file);
    } else {
        saveVehicleData();
    }
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    setTimeout(() => {
        document.getElementById('modal-container').innerHTML = '';
    }, 300);
}

function prefillSurvey(custId, vehId) {
    document.getElementById('survey-customer-select').value = custId;
    surveyCustomerChanged();
    setTimeout(() => {
        document.getElementById('survey-vehicle-select').value = vehId;
        surveyVehicleChanged();
    }, 50);
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');
    const savedPage = localStorage.getItem('redrivo_crm_page');
    
    if (window.location.hash === '#public-survey') {
        router.navigate('public-survey');
    } else if (viewParam) {
        router.navigate(viewParam);
    } else if (savedPage && savedPage !== 'login' && savedPage !== 'public-survey') {
        router.navigate(savedPage);
    } else {
        router.navigate('dashboard');
    }
});



function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function renderAnomalousTrips() {
    const trips = PROTOTYPE_STATE.trips || [];
    const requests = PROTOTYPE_STATE.serviceRequests || [];
    const garages = PROTOTYPE_STATE.garages || [];

    const anomalousTrips = [];

    trips.forEach(trip => {
        if (!trip.finalOdometer || !trip.startOdometer || !trip.pickupLat || !trip.pickupLng) return;
        
        const req = requests.find(r => r.id === trip.serviceRequestId);
        if (!req || !req.assignedGarageId) return;

        const garage = garages.find(g => g.id === req.assignedGarageId);
        if (!garage || !garage.lat || !garage.lng) return;

        const actualDistance = trip.finalOdometer - trip.startOdometer;
        const directRoute = haversine(trip.pickupLat, trip.pickupLng, garage.lat, garage.lng);
        
        // Let's assume return direct route is the same, so total direct should be directRoute * 2 if it's round trip. 
        // Wait, the trip represents one way? Marshal picks up and drops to garage. Yes, one way.
        const threshold = directRoute * 1.15; // Direct Route + 15%
        
        if (actualDistance > threshold && actualDistance > 1) { // >1 to avoid floating point small anomalies
            anomalousTrips.push({
                trip,
                req,
                garage,
                actualDistance,
                directRoute,
                excess: actualDistance - directRoute
            });
        }
    });

    let html = `
        <div class="card" style="border-left: 4px solid var(--danger)">
            <h3><i data-lucide="alert-triangle" style="vertical-align: middle; margin-right: 8px; color: var(--danger)"></i> Anomalous Trips Flagged</h3>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 20px;">
                Trips where Actual Distance > (Direct Route + 15%).
            </p>
    `;

    if (anomalousTrips.length === 0) {
        html += `<div class="text-muted">No anomalous trips detected.</div></div>`;
        return html;
    }

    html += `
            <div style="max-height: 400px; overflow-y: auto;">
                ${anomalousTrips.map(a => `
                    <div style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 15px; margin-bottom: 15px; background: rgba(255,0,0,0.02)">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 10px;">
                            <div style="font-weight: 600">Trip #${a.trip.id.substring(0, 8)} | Req #${a.req.id}</div>
                            <span class="badge badge-danger">Flagged</span>
                        </div>
                        <div class="grid-3" style="gap: 10px; margin-bottom: 15px;">
                            <div style="background: var(--bg-surface); padding: 10px; border-radius: 4px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted)">Actual Distance</div>
                                <div style="font-weight: 600; color: var(--text-main)">${a.actualDistance.toFixed(1)} km</div>
                            </div>
                            <div style="background: var(--bg-surface); padding: 10px; border-radius: 4px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted)">Direct Route</div>
                                <div style="font-weight: 600; color: var(--text-main)">${a.directRoute.toFixed(1)} km</div>
                            </div>
                            <div style="background: var(--bg-surface); padding: 10px; border-radius: 4px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted)">Excess Travel</div>
                                <div style="font-weight: 600; color: var(--danger)">+${a.excess.toFixed(1)} km</div>
                            </div>
                        </div>
                        <div style="display:flex; justify-content:flex-end;">
                            <button onclick="openVideoComparisonModal('${a.trip.id}')" class="btn btn-secondary">
                                <i data-lucide="split-square-horizontal"></i> Dispute Resolution (Video)
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    return html;
}

async function openVideoComparisonModal(tripId) {
    // Show a loading state or modal framework immediately
    const modalHtml = `
        <div class="modal-overlay open" id="modal-video-comparison">
            <div class="modal-content" style="max-width: 900px; width: 95%;">
                <div style="display:flex; justify-content:space-between; margin-bottom: var(--space-lg)">
                    <h2><i data-lucide="scale"></i> Dispute Resolution: Trip #${tripId.substring(0, 8)}</h2>
                    <button onclick="closeModal('modal-video-comparison')" class="btn btn-secondary" style="padding: 4px 8px">X</button>
                </div>
                
                <div id="video-comparison-content" style="text-align: center; padding: 40px; color: var(--text-muted);">
                    Loading 360° Media...
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;
    lucide.createIcons();

    try {
        const res = await fetch(`${API_URL}/media/${tripId}`);
        const media = await res.json();
        
        const pickupMedia = media.find(m => m.type === '360_pickup');
        const deliveryMedia = media.find(m => m.type === 'final_delivery');

        let contentHtml = `
            <div class="grid-2" style="gap: 20px;">
                <div class="card" style="margin: 0; padding: 10px;">
                    <h3 style="text-align: center; margin-bottom: 10px;">Pickup 360°</h3>
                    ${pickupMedia ? `
                        <video controls style="width: 100%; border-radius: var(--radius-md); max-height: 400px; background: #000;">
                            <source src="${BASE_URL}/${pickupMedia.filePath}" type="video/mp4">
                            Your browser does not support HTML video.
                        </video>
                    ` : `<div style="height: 200px; display:flex; align-items:center; justify-content:center; background: var(--bg-dark); border-radius: var(--radius-md);">No Pickup Video Found</div>`}
                </div>
                
                <div class="card" style="margin: 0; padding: 10px;">
                    <h3 style="text-align: center; margin-bottom: 10px;">Delivery 360°</h3>
                    ${deliveryMedia ? `
                        <video controls style="width: 100%; border-radius: var(--radius-md); max-height: 400px; background: #000;">
                            <source src="${BASE_URL}/${deliveryMedia.filePath}" type="video/mp4">
                            Your browser does not support HTML video.
                        </video>
                    ` : `<div style="height: 200px; display:flex; align-items:center; justify-content:center; background: var(--bg-dark); border-radius: var(--radius-md);">No Delivery Video Found</div>`}
                </div>
            </div>
            <div style="margin-top: 20px; font-size: 0.9rem; color: var(--text-muted); text-align: center;">
                Compare videos side-by-side to review vehicle condition and resolve disputes regarding scratches, dents, or cleanliness.
            </div>
        `;
        
        document.getElementById('video-comparison-content').innerHTML = contentHtml;
    } catch (e) {
        document.getElementById('video-comparison-content').innerHTML = `
            <div style="color: var(--danger);">Failed to load media: ${e.message}</div>
        `;
    }
}

function renderSKUCatalog(container) {
    const skus = PROTOTYPE_STATE.skus;
    
    const html = `
        <div class="header" style="display:flex; justify-content:space-between; align-items:flex-end; padding-bottom: 10px; border-bottom: 1px solid var(--border);">
            <div>
                <h1 class="page-title" style="margin:0; display:flex; align-items:center; gap:12px;">
                    Master SKU Catalog 
                    <span style="font-size:0.7rem; font-weight:400; padding:4px 10px; background:rgba(255,255,255,0.05); border-radius:20px; color:var(--text-dim); border:1px solid var(--border);">
                        ${skus.length} Items
                    </span>
                </h1>
                <div style="font-size:0.8rem; color:var(--text-dim); margin-top:6px;">Global parts inventory and pricing management hub.</div>
            </div>
            <div style="display:flex; gap:10px;">
                <button onclick="toggleSKUEdit()" id="btn-sku-edit" class="btn btn-secondary" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); padding: 8px 16px; border-radius: 8px; font-weight: 600;">
                    <i data-lucide="edit-3" style="width:14px; margin-right:6px;"></i> Edit
                </button>
                <button onclick="saveAllMasterSKUs()" id="btn-sku-save-all" class="btn btn-primary" style="display:none; padding: 8px 20px; border-radius: 8px; font-weight: 700;">
                    <i data-lucide="save" style="width:14px; margin-right:6px;"></i> Save
                </button>
            </div>
        </div>

        <div style="margin-top: 25px;">
            <div style="margin-bottom: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                <div style="position:relative;">
                    <label style="position:absolute; top:-8px; left:12px; background:var(--bg-main); padding:0 6px; font-size:0.6rem; color:var(--text-dim); z-index:1; font-weight:700; letter-spacing:0.5px;">PART NAME</label>
                    <input type="text" id="sku-search-name" placeholder="Search item..." class="input" oninput="filterSKUCatalog()" style="height:44px; border-color:rgba(255,255,255,0.08); background:rgba(255,255,255,0.01);">
                </div>
                <div style="position:relative;">
                    <label style="position:absolute; top:-8px; left:12px; background:var(--bg-main); padding:0 6px; font-size:0.6rem; color:var(--text-dim); z-index:1; font-weight:700; letter-spacing:0.5px;">CATEGORY</label>
                    <input type="text" id="sku-search-cat" placeholder="Filter category..." class="input" oninput="filterSKUCatalog()" style="height:44px; border-color:rgba(255,255,255,0.08); background:rgba(255,255,255,0.01);">
                </div>
                <div style="position:relative;">
                    <label style="position:absolute; top:-8px; left:12px; background:var(--bg-main); padding:0 6px; font-size:0.6rem; color:var(--text-dim); z-index:1; font-weight:700; letter-spacing:0.5px;">BRAND</label>
                    <input type="text" id="sku-search-brand" placeholder="Filter brand..." class="input" oninput="filterSKUCatalog()" style="height:44px; border-color:rgba(255,255,255,0.08); background:rgba(255,255,255,0.01);">
                </div>
            </div>

            <table class="table">
                <thead>
                    <tr style="border-bottom: 2px solid var(--border);">
                        <th style="font-size:0.7rem; color:var(--text-dim); padding-bottom:12px; width: 40px;">SL.</th>
                        <th style="font-size:0.7rem; color:var(--text-dim); padding-bottom:12px;">CATEGORY</th>
                        <th style="font-size:0.7rem; color:var(--text-dim); padding-bottom:12px;">ITEM SPECIFICATIONS</th>
                        <th style="font-size:0.7rem; color:var(--text-dim); padding-bottom:12px;">BRAND</th>
                        <th style="text-align: center; font-size:0.7rem; color:var(--text-dim); padding-bottom:12px;">ACTIVATIONS</th>
                        <th style="text-align: center; font-size:0.7rem; color:var(--text-dim); padding-bottom:12px;">STOCK</th>
                        <th style="text-align: center; font-size:0.7rem; color:var(--text-dim); padding-bottom:12px; width: 120px;">MRP (BASE ₹)</th>
                        <th style="text-align: center; font-size:0.7rem; color:var(--text-muted); padding-bottom:12px; width: 130px;">REDRIVO OFFER</th>
                        <th style="text-align: right; width: 40px; padding-bottom:12px;"></th>
                    </tr>
                </thead>
                <tbody id="sku-catalog-tbody">
                    ${renderSKULines(skus)}
                </tbody>
            </table>
        </div>
    `;
    container.innerHTML = html;
    lucide.createIcons();
}

function renderSKULines(skus) {
    const locked = !skuCatalogEditMode;
    const inpStyle = (isV) => `border:none; background:transparent; text-align: center; padding: 8px 4px; height: 36px; width:100%; font-size:0.9rem; font-weight:700; ${locked ? 'cursor:not-allowed;' : 'color:#fff;'}`;

    return skus.map((s, idx) => `
        <tr id="sku-row-${s.id}" class="sku-data-row" data-id="${s.id}">
            <td style="vertical-align: middle; color:var(--text-dim); font-size:0.75rem; font-weight:700;">${idx + 1}</td>
            <td style="vertical-align: middle;"><span class="badge badge-secondary" style="font-size:0.65rem;">${s.category.toUpperCase()}</span></td>
            <td>
                <div style="font-weight:700; color:var(--text-main); font-size:0.9rem;">${s.itemName}</div>
                <div style="font-size:0.7rem; color:var(--text-dim); margin-top:2px;">${s.id} | ${s.compatibleBrands || 'Universal Fit'}</div>
            </td>
            <td style="vertical-align: middle; color:var(--text-dim); font-size:0.85rem;">${s.sparePartBrand || '-'}</td>
            <td style="text-align: center; vertical-align: middle;">
                <button onclick="viewSKUActivations('${s.id}')" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 0.7rem; border-color:rgba(255,255,255,0.05); background:rgba(255,255,255,0.02);">
                    ${s.activationCount || 0} Garages
                </button>
            </td>
            <td style="text-align: center; vertical-align: middle;">
                <div style="font-weight:800; color:${(s.totalStock || 0) < 5 ? 'var(--danger)' : 'var(--success)'}; font-size:1.1rem; line-height:1;">
                    ${s.totalStock || 0}
                </div>
                <div style="font-size:0.55rem; color:var(--text-dim); text-transform:uppercase; margin-top:2px;">Stock</div>
            </td>
            <td style="vertical-align: middle;">
                <div style="display:flex; align-items:center; background:rgba(255,255,255,${locked ? '0.01' : '0.04'}); border:1px solid rgba(255,255,255,${locked ? '0.05' : '0.15'}); border-radius:6px; padding:0 8px;">
                    <span style="font-size:0.75rem; color:var(--text-dim);">₹</span>
                    <input type="number" id="mrp-${s.id}" value="${s.basePrice || 0}" class="input sku-mrp-in" ${locked ? 'disabled' : ''} style="${inpStyle(false)}">
                </div>
            </td>
            <td style="vertical-align: middle;">
                <div style="display:flex; align-items:center; background:rgba(255,62,5,${locked ? '0.01' : '0.05'}); border:1px solid rgba(255,62,5,${locked ? '0.05' : '0.25'}); border-radius:6px; padding:0 8px;">
                    <span style="font-size:0.75rem; color:var(--primary);">₹</span>
                    <input type="number" id="vprice-${s.id}" value="${s.vroomerPrice || 0}" class="input sku-vprice-in" ${locked ? 'disabled' : ''} style="${inpStyle(true)} color:${locked ? 'var(--primary-muted)' : 'var(--primary)'};">
                </div>
            </td>
            <td style="text-align: right; vertical-align: middle;">
                <button onclick="pushSKUToGarage('${s.id}')" class="btn btn-secondary btn-sm" style="padding: 4px; border:none; background:none; opacity:0.6;" title="Push to Garage">
                    <i data-lucide="share-2" style="width:16px;"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function toggleSKUEdit() {
    skuCatalogEditMode = !skuCatalogEditMode;
    const btn = document.getElementById('btn-sku-edit');
    const saveBtn = document.getElementById('btn-sku-save-all');
    
    if (skuCatalogEditMode) {
        btn.innerHTML = '<i data-lucide="x" style="width:14px; margin-right:6px;"></i> Cancel';
        btn.style.color = 'var(--danger)';
        btn.style.background = 'rgba(255, 62, 5, 0.1)';
        saveBtn.style.display = 'inline-flex';
    } else {
        btn.innerHTML = '<i data-lucide="edit-3" style="width:14px; margin-right:6px;"></i> Edit';
        btn.style.color = '#fff';
        btn.style.background = 'rgba(255,255,255,0.03)';
        saveBtn.style.display = 'none';
    }
    
    // Partial re-render to avoid losing search state
    document.getElementById('sku-catalog-tbody').innerHTML = renderSKULines(PROTOTYPE_STATE.skus);
    if (window.lucide) lucide.createIcons();
    filterSKUCatalog(); // Keep current filters
}

async function saveAllMasterSKUs() {
    const btn = document.getElementById('btn-sku-save-all');
    const rows = document.querySelectorAll('.sku-data-row');
    
    btn.innerHTML = '<div class="loader-spin" style="width:14px; height:14px; margin-right:8px;"></div> Saving...';
    btn.disabled = true;
    
    let savedCount = 0;
    for (const row of rows) {
        const id = row.dataset.id;
        const mrpInput = document.getElementById(`mrp-${id}`);
        const vpriceInput = document.getElementById(`vprice-${id}`);
        
        if (!mrpInput || !vpriceInput) continue;
        
        const mrp = parseFloat(mrpInput.value);
        const vprice = parseFloat(vpriceInput.value);
        
        // Find if changed
        const sku = PROTOTYPE_STATE.skus.find(s => s.id === id);
        if (sku && (sku.basePrice !== mrp || sku.vroomerPrice !== vprice)) {
            try {
                await fetch(`${API_URL}/skus/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ basePrice: mrp, vroomerPrice: vprice })
                });
                sku.basePrice = mrp;
                sku.vroomerPrice = vprice;
                savedCount++;
            } catch (e) { console.error('Save failed for', id, e); }
        }
    }
    
    btn.textContent = 'Saved!';
    btn.style.background = 'var(--success)';
    setTimeout(() => {
        toggleSKUEdit();
        btn.textContent = 'Save';
        btn.style.background = 'var(--primary)';
        btn.disabled = false;
    }, 1000);
}

function filterSKUCatalog() {
    const name = document.getElementById('sku-search-name').value.toLowerCase();
    const cat = document.getElementById('sku-search-cat').value.toLowerCase();
    const brand = document.getElementById('sku-search-brand').value.toLowerCase();
    
    const filtered = PROTOTYPE_STATE.skus.filter(s => 
        (s.itemName || '').toLowerCase().includes(name) &&
        (s.category || '').toLowerCase().includes(cat) &&
        (s.sparePartBrand || '').toLowerCase().includes(brand)
    );
    
    document.getElementById('sku-catalog-tbody').innerHTML = renderSKULines(filtered);
}

async function updateMasterSKU(skuId) {
    const mrp = document.getElementById(`mrp-${skuId}`).value;
    const vprice = document.getElementById(`vprice-${skuId}`).value;
    
    try {
        const res = await fetch(`${API_URL}/skus/${skuId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                basePrice: parseFloat(mrp), 
                vroomerPrice: parseFloat(vprice) 
            })
        });
        
        if (!res.ok) throw new Error('Update failed');
        
        // Update local state
        const sku = PROTOTYPE_STATE.skus.find(s => s.id === skuId);
        if (sku) {
            sku.basePrice = parseFloat(mrp);
            sku.vroomerPrice = parseFloat(vprice);
        }
        
        const btn = document.querySelector(`#sku-row-${skuId} .btn-primary`);
        btn.textContent = 'Saved!';
        btn.classList.replace('btn-primary', 'btn-success');
        setTimeout(() => {
            btn.textContent = 'Save';
            btn.classList.replace('btn-success', 'btn-primary');
        }, 1500);
        
    } catch (err) {
        alert('Error updating SKU: ' + err.message);
    }
}

async function viewSKUActivations(skuId) {
    const sku = PROTOTYPE_STATE.skus.find(s => s.id === skuId);
    if (!sku) return;

    try {
        const res = await fetch(`${API_URL}/skus/${skuId}/garages`);
        const garages = await res.json();
        
        const modalHtml = `
            <div class="modal-overlay open" id="modal-sku-activations">
                <div class="modal-content" style="max-width: 700px;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; width: 100%;">
                            <div>
                                <h2 style="margin:0;">Activations & Allotment</h2>
                                <div style="color: var(--text-muted); font-size: 0.9rem; margin-top:4px;">${sku.itemName} | ${sku.id}</div>
                            </div>
                            <div style="text-align: right; display:flex; gap:15px; align-items:center;">
                                <div style="background:rgba(255,255,255,0.05); padding:8px 15px; border-radius:8px; border:1px solid var(--border);">
                                    <div style="font-size:0.6rem; color:var(--text-dim); text-transform:uppercase; margin-bottom:2px;">Total Allotted Stock</div>
                                    <div style="font-size:1.2rem; font-weight:800; color:var(--success); line-height:1;">${sku.totalStock || 0}</div>
                                </div>
                                <button onclick="closeModal('modal-sku-activations')" class="btn btn-secondary" style="padding: 4px 8px;">✕</button>
                            </div>
                        </div>

                    <div style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 15px; border: 1px solid var(--border);">
                        <table class="table" style="margin:0;">
                            <thead>
                                <tr>
                                    <th style="text-align: left;">Garage Name</th>
                                    <th style="text-align: left;">Location</th>
                                    <th style="text-align: center;">ReDrivo Price</th>
                                    <th style="text-align: center;">Garage Selling Price</th>
                                    <th style="text-align: center;">Stock</th>
                                    <th style="text-align: center;">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${garages.map(g => `
                                    <tr>
                                        <td style="font-weight:600;">${g.name}</td>
                                        <td style="font-size:0.85rem; color:var(--text-muted);">${g.location || '-'}</td>
                                        <td style="text-align: center; font-weight:700; color:var(--text-dim);">₹${g.redrivoPrice || 0}</td>
                                        <td style="text-align: center; font-weight:700; color:var(--primary);">₹${g.garagePrice || 0}</td>
                                        <td style="text-align: center; font-weight:800;">${g.stock}</td>
                                        <td style="text-align: center;">
                                            <span class="badge ${g.status === 'active' ? 'badge-success' : 'badge-secondary'}">${g.status}</span>
                                        </td>
                                    </tr>
                                `).join('')}
                                ${garages.length === 0 ? '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">No activations found for this part.</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>

                    <div style="margin-top: 25px; text-align: right;">
                        <button onclick="closeModal('modal-sku-activations')" class="btn btn-primary">Close</button>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('modal-container').innerHTML = modalHtml;
    } catch (err) {
        alert('Failed/Error loading activations: ' + err.message);
    }
}

// --- MASTER CATALOG (Shared with Garage Portal) ---
const MASTER_CATALOG = [
    // --- Car General Servicing ---
    { cat: 'General Servicing', item: 'Basic Service (Oil + Filter)', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Standard Service Package', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Comprehensive Service Package', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Periodic Maintenance Service', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Pre-Purchase Inspection', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Post-Accident Inspection', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'AC Gas Refill', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'AC Service (Full)', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Wheel Alignment', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Balancing (per wheel)', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Tyre Rotation', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Battery Load Test', vType: 'Car', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Engine Diagnostics (OBD)', vType: 'Car', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Brake Fluid Flush', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Coolant Flush', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Fuel Injector Cleaning', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Throttle Body Cleaning', vType: 'Car', canRepair: true, canReplace: false },

    // --- Engine and Fluids ---
    { cat: 'Engine and Fluids', item: 'Engine Oil Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Oil Filter', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Coolant Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Brake Fluid Level', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Engine and Fluids', item: 'Air Filter', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Front Brake Pads', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Rear Brake Pads', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Safety and Brakes', item: 'Brake Discs', vType: 'Car', canRepair: true, canReplace: true },
    { cat: 'Electricals', item: 'Headlights', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Horn', vType: 'Car', canRepair: false, canReplace: true },
    { cat: 'Suspension', item: 'Front Strut', vType: 'Car', canRepair: false, canReplace: true },

    // --- Bike General Servicing ---
    { cat: 'General Servicing', item: 'Basic Service (Oil + Filter)', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Standard Service Package', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Comprehensive Service Package', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'General Servicing', item: 'Pre-Purchase Inspection', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Engine Diagnostics', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Alignment', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Wheel Balancing (per wheel)', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Chain Lubrication and Tightening', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'General Servicing', item: 'Battery Load Test', vType: 'Bike', canRepair: false, canReplace: false },
    { cat: 'General Servicing', item: 'Carburettor Cleaning', vType: 'Bike', canRepair: true, canReplace: true },
    { cat: 'General Servicing', item: 'Throttle and Cable Adjustment', vType: 'Bike', canRepair: true, canReplace: false },

    // --- Bike Engine ---
    { cat: 'Engine', item: 'Engine Oil', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Engine', item: 'Spark Plug', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Drive', item: 'Chain Tensioning', vType: 'Bike', canRepair: true, canReplace: false },
    { cat: 'Brakes', item: 'Brake Pad', vType: 'Bike', canRepair: false, canReplace: true },
    { cat: 'Electricals', item: 'Battery', vType: 'Bike', canRepair: false, canReplace: true }
];

async function renderAllCharges(container) {
    container.innerHTML = `
        <div class="header" style="display:flex; justify-content:space-between; align-items:center">
            <h1 class="page-title">Platform Charges Hub</h1>
            <div style="display:flex; gap: 10px;">
                <button class="btn btn-secondary" onclick="renderAllCharges(document.getElementById('app'))"><i data-lucide="refresh-cw"></i> Refresh</button>
            </div>
        </div>

        <!-- Global Settings Controls -->
        <div class="card" style="margin-top: 20px; padding: 20px; border: 1px solid var(--border); background: var(--bg-surface);">
            <h3 style="margin-top:0; color:var(--text-main); font-size:1rem; display:flex; align-items:center; gap:8px;">
                <i data-lucide="settings" style="color:var(--primary); width:18px; height:18px;"></i>
                Global Logistics & Driver Settings
            </h3>
            <p style="font-size:0.75rem; color:var(--text-dim); margin: 4px 0 20px 0;">Configure the dynamic rate charged to customers per KM and the driver commission incentive percentage of target ticket sizes.</p>
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:20px;">
                <div class="form-group">
                    <label class="label">Customer Delivery Rate (per KM) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-customer-rate" class="input" style="height:42px;" placeholder="e.g. 15" value="15">
                        <button class="btn btn-primary" onclick="saveSystemSetting('customer_rate_per_km', document.getElementById('setting-customer-rate').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">Driver Rating Threshold *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-rating-threshold" class="input" style="height:42px;" placeholder="e.g. 4.5" value="4.5" step="0.1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('marshal_rating_threshold', document.getElementById('setting-rating-threshold').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">High Tier Commission (%) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-commission-high" class="input" style="height:42px;" placeholder="e.g. 80" value="80" step="0.1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('commission_high_tier', document.getElementById('setting-commission-high').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">Low Tier Commission (%) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-commission-low" class="input" style="height:42px;" placeholder="e.g. 65" value="65" step="0.1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('commission_low_tier', document.getElementById('setting-commission-low').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">5-Star Bonus Ticket Size (%) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-bonus-5star" class="input" style="height:42px;" placeholder="e.g. 5.0" value="5.0" step="0.1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('bonus_5_star_percentage', document.getElementById('setting-bonus-5star').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">Towing Base Surcharge (₹) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-towing-base" class="input" style="height:42px;" placeholder="e.g. 500" value="500" step="1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('towing_base_fee', document.getElementById('setting-towing-base').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="label">Towing Rate Per KM (₹) *</label>
                    <div style="display:flex; gap:8px;">
                        <input type="number" id="setting-towing-per-km" class="input" style="height:42px;" placeholder="e.g. 30" value="30" step="1">
                        <button class="btn btn-primary" onclick="saveSystemSetting('towing_rate_per_km', document.getElementById('setting-towing-per-km').value)" style="height:42px; padding:0 20px;">Save</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="card" style="margin-top: 20px; padding:0;">
            <div style="background: rgba(255,62,5,0.05); padding: 15px 20px; border-bottom: 1px solid rgba(255,62,5,0.2); display: flex; justify-content: space-between; align-items: center;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <i data-lucide="award" style="color:var(--primary);"></i>
                    <div>
                        <div style="font-weight:700; color:var(--primary); font-size:0.9rem;">USP HIGHLIGHT: 500-Point Health Report</div>
                        <div style="font-size:0.75rem; color:var(--text-dim);">Real-time monitoring of flagship inspection charges</div>
                    </div>
                </div>
                <div id="usp-rate-summary" style="display:flex; gap:20px;"><!-- Avg rates by segment will appear here -->
                </div>
            </div>
            <div style="display:flex; border-bottom: 1px solid var(--border);">
                <button id="tab-sku-prices" class="tab-btn active" onclick="switchChargeTab('sku')" style="padding: 15px 25px; border:none; background:none; color:var(--text-main); font-weight:700; cursor:pointer;">Master SKU Prices</button>
                <button id="tab-garage-rates" class="tab-btn" onclick="switchChargeTab('garage')" style="padding: 15px 25px; border:none; background:none; color:var(--text-dim); font-weight:700; cursor:pointer;">Garage Service Rates</button>
            </div>

            <div id="charge-content" style="padding: 20px;">
                <div id="charge-sku-view">
                    <div style="margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <input type="text" id="charge-sku-search" placeholder="Search Part..." class="input" oninput="filterChargeSKUs()">
                        <div style="color:var(--text-dim); font-size:0.85rem; display:flex; align-items:center; justify-content:flex-end;">Showing all platform MRP and ReDrivo Offer prices</div>
                    </div>
                    <table class="table" style="table-layout: fixed; width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr>
                                <th style="width: 120px; text-align: left; padding-left: 15px;">Category</th>
                                <th style="width: 300px; text-align: left;">Item Name</th>
                                <th style="width: 150px; text-align: left;">Brand</th>
                                <th style="text-align: right; width: 130px; padding-right: 20px;">Platform MRP</th>
                                <th style="text-align: right; width: 130px; padding-right: 20px;">ReDrivo Offer</th>
                                <th style="text-align: center; width: 120px;">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="charge-sku-tbody"></tbody>
                    </table>
                </div>
                <div id="charge-garage-view" style="display:none;">
                    <div style="margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                        <input type="text" id="charge-rate-search" placeholder="Search Service..." class="input" oninput="filterChargeRates()">
                        <select id="charge-rate-segment" class="input" onchange="filterChargeRates()">
                            <option value="">All Segments</option>
                            <option value="Hatchback">Hatchback</option>
                            <option value="Sedan">Sedan</option>
                            <option value="SUV">SUV</option>
                            <option value="Luxury">Luxury</option>
                            <option value="Universal">Universal</option>
                        </select>
                        <div id="rate-count" style="color:var(--text-dim); font-size:0.85rem; display:flex; align-items:center; justify-content:flex-end;">Loading...</div>
                    </div>
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Category</th>
                                <th>Service Item</th>
                                <th>Segment</th>
                                <th style="text-align: center;">Avg Repair</th>
                                <th style="text-align: center;">Avg Replace</th>
                                <th style="text-align: center;">Avg Labor</th>
                            </tr>
                        </thead>
                        <tbody id="charge-rate-tbody"></tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    lucide.createIcons();
    
    // Initial load
    renderChargeSKUs();

    // Fetch and populate dynamic settings
    try {
        const settings = await fetch(`${API_URL}/system-settings`).then(r => r.json());
        if (settings['customer_rate_per_km']) {
            document.getElementById('setting-customer-rate').value = settings['customer_rate_per_km'];
        }
        if (settings['marshal_rating_threshold']) {
            document.getElementById('setting-rating-threshold').value = settings['marshal_rating_threshold'];
        }
        if (settings['commission_high_tier']) {
            document.getElementById('setting-commission-high').value = settings['commission_high_tier'];
        }
        if (settings['commission_low_tier']) {
            document.getElementById('setting-commission-low').value = settings['commission_low_tier'];
        }
        if (settings['bonus_5_star_percentage']) {
            document.getElementById('setting-bonus-5star').value = settings['bonus_5_star_percentage'];
        }
        if (settings['towing_base_fee']) {
            document.getElementById('setting-towing-base').value = settings['towing_base_fee'];
        }
        if (settings['towing_rate_per_km']) {
            document.getElementById('setting-towing-per-km').value = settings['towing_rate_per_km'];
        }
    } catch (err) {
        console.warn('Error loading system settings', err);
    }
}

window.saveSystemSetting = async function(key, value) {
    if (!value || isNaN(parseFloat(value))) {
        showAlert('Error', 'Please enter a valid numeric value.', 'Close', 'error');
        return;
    }
    try {
        const res = await fetch(`${API_URL}/system-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: parseFloat(value).toString() })
        });
        if (res.ok) {
            showAlert('Success', 'Setting saved successfully!', 'OK', 'success');
            await fetchRealtimeData();
        } else {
            showAlert('Error', 'Failed to save settings.', 'Close', 'error');
        }
    } catch (err) {
        showAlert('Error', 'Connection error: ' + err.message, 'Close', 'error');
    }
};

function switchChargeTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.color = 'var(--text-dim)';
    });
    const activeTab = document.getElementById(`tab-${tab}-prices`) || document.getElementById(`tab-${tab}-rates`);
    activeTab.classList.add('active');
    activeTab.style.color = 'var(--text-main)';
    activeTab.style.borderBottom = '2px solid var(--primary)';

    document.getElementById('charge-sku-view').style.display = tab === 'sku' ? 'block' : 'none';
    document.getElementById('charge-garage-view').style.display = tab === 'garage' ? 'block' : 'none';
    
    if (tab === 'garage') loadAllGarageRates();
}

function renderChargeSKUs(skus = PROTOTYPE_STATE.skus) {
    const tbody = document.getElementById('charge-sku-tbody');
    if (!tbody) return;
    
    if (skus.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-dim);">No matching parts found</td></tr>`;
        return;
    }

    tbody.innerHTML = skus.map(s => `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
            <td style="vertical-align: middle; padding-left: 15px;"><span class="badge badge-secondary" style="font-size:0.65rem; padding: 4px 8px;">${s.category ? s.category.toUpperCase() : 'PART'}</span></td>
            <td>
                <div style="font-weight:700; color:var(--text-main); font-size:0.9rem;">${s.itemName}</div>
                <div style="font-size:0.65rem; color:var(--text-dim); font-family: monospace; margin-top:2px;">ID: ${s.id}</div>
            </td>
            <td style="vertical-align: middle; color:var(--text-dim); font-size:0.9rem;">${s.sparePartBrand || 'Generic'}</td>
            <td style="text-align: right; vertical-align: middle; font-weight:700; font-family: monospace; color:var(--text-dim); padding-right: 20px;">₹${s.basePrice || 0}</td>
            <td style="text-align: right; vertical-align: middle; color:var(--primary); font-weight:800; font-family: monospace; font-size:1.05rem; padding-right: 20px;">₹${s.vroomerPrice || 0}</td>
            <td style="text-align: center; vertical-align: middle;">
                <button onclick="openManageSerials('${s.id}')" class="btn btn-secondary btn-sm" style="padding:6px 12px; font-size:0.75rem; border-radius:6px; background:rgba(255,255,255,0.05);">
                    <i data-lucide="package" style="width:14px; height:14px; margin-right:4px; vertical-align:middle;"></i> Serials
                </button>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

function filterChargeSKUs() {
    const query = document.getElementById('charge-sku-search')?.value.toLowerCase() || '';
    const filtered = PROTOTYPE_STATE.skus.filter(s => 
        s.itemName.toLowerCase().includes(query) || 
        s.category.toLowerCase().includes(query) ||
        s.id.toLowerCase().includes(query)
    );
    renderChargeSKUs(filtered);
}

async function filterChargeRates() {
    const query = document.getElementById('charge-rate-search')?.value.toLowerCase() || '';
    const segment = document.getElementById('charge-rate-segment')?.value || '';
    
    const tbody = document.getElementById('charge-rate-tbody');
    const countEl = document.getElementById('rate-count');
    if (!tbody) return;

    const allRates = await loadAllGarageRates();
    const filtered = allRates.filter(r => {
        const matchesQuery = r.item.toLowerCase().includes(query) || r.cat.toLowerCase().includes(query);
        const matchesSegment = !segment || r.segment === segment;
        return matchesQuery && matchesSegment;
    });

    countEl.textContent = `Displaying ${filtered.length} service price points`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-dim);">No service rates found</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(r => `
        <tr>
            <td><span class="badge badge-secondary" style="font-size:0.6rem; padding:4px 8px;">${r.cat.toUpperCase()}</span></td>
            <td style="font-weight:600;">${r.item}</td>
            <td><span class="badge ${r.segment === 'Universal' ? 'badge-outline' : 'badge-primary'}" style="font-size:0.65rem;">${r.segment}</span></td>
            <td style="text-align: center; font-weight:700;">₹${Math.round(r.avgRepair)}</td>
            <td style="text-align: center; font-weight:700;">₹${Math.round(r.avgReplace)}</td>
            <td style="text-align: center; font-weight:700; color:var(--info);">₹${Math.round(r.avgLabor)}</td>
        </tr>
    `).join('');
}

function openManageSerials(skuId) {
    const sku = PROTOTYPE_STATE.skus.find(s => s.id === skuId);
    const serials = PROTOTYPE_STATE.serializedParts.filter(sp => sp.skuId === skuId);
    const garages = PROTOTYPE_STATE.garages;

    const modalHtml = `
        <div id="modal-manage-serials" class="modal-overlay" style="display: flex;">
            <div class="modal-card" style="width: 100%; max-width: 700px; max-height: 85vh; overflow-y: auto;">
                <div class="modal-header">
                    <div>
                        <h2 style="margin:0;">Manage Serials: ${sku.itemName}</h2>
                        <p style="font-size:0.8rem; color:var(--text-dim); margin-top:4px;">Assign ReDrivo parts to specific garages</p>
                    </div>
                    <button onclick="closeModal('modal-manage-serials')" class="btn-icon"><i data-lucide="x"></i></button>
                </div>
                
                <div style="background:rgba(255,255,255,0.02); padding:15px; border-radius:12px; border:1px solid var(--border); margin-bottom:20px; display:flex; gap:10px; align-items:flex-end;">
                    <div style="flex:1;">
                        <label class="label">ADD NEW SERIAL</label>
                        <input type="text" id="new-serial-num" class="input" placeholder="e.g. GX-0001-P3" style="background:var(--bg-base);">
                    </div>
                    <div style="flex:1;">
                        <label class="label">ASSIGN TO GARAGE</label>
                        <select id="assign-garage-id" class="input" style="background:var(--bg-base);">
                            <option value="">Select Garage...</option>
                            ${garages.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
                        </select>
                    </div>
                    <button onclick="addSerializedPart('${skuId}')" class="btn btn-primary" style="height:42px;">Assign</button>
                </div>

                <table class="table">
                    <thead>
                        <tr>
                            <th>Serial Number</th>
                            <th>Assigned To</th>
                            <th>Status</th>
                            <th>Assigned At</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${serials.map(sp => {
                            const garage = garages.find(g => g.id === sp.garageId);
                            return `
                                <tr>
                                    <td style="font-family:monospace; font-weight:700;">${sp.serialNumber}</td>
                                    <td>${garage ? garage.name : 'Unknown'}</td>
                                    <td>
                                        <span class="badge ${sp.status === 'used' ? 'badge-success' : 'badge-warning'}">
                                            ${sp.status.toUpperCase()}
                                        </span>
                                    </td>
                                    <td style="font-size:0.75rem; color:var(--text-dim);">
                                        ${new Date(sp.assignedAt).toLocaleDateString()}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                        ${serials.length === 0 ? '<tr><td colspan="4" style="text-align:center; color:var(--text-dim); padding:20px;">No serial numbers tracked for this SKU</td></tr>' : ''}
                    </tbody>
                </table>
            </div>
        </div>
    `;
    const container = document.getElementById('modal-container');
    if (container) {
        container.innerHTML = modalHtml;
        lucide.createIcons();
    }
}

async function addSerializedPart(skuId) {
    const serialNumber = document.getElementById('new-serial-num').value.trim();
    const garageId = document.getElementById('assign-garage-id').value;

    if (!serialNumber || !garageId) {
        alert('Both Serial Number and Garage are required');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/serialized-parts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skuId, serialNumber, garageId })
        });
        if (res.ok) {
            alert('Part Assigned Successfully');
            // Re-fetch data and re-render modal
            await fetchRealtimeData();
            openManageSerials(skuId);
        } else {
            const data = await res.json();
            alert('Error: ' + data.error);
        }
    } catch (e) {
        alert('Connection error');
    }
}

let aggregatedRates = [];
async function loadAllGarageRates() {
    const tbody = document.getElementById('charge-rate-tbody');
    const status = document.getElementById('rate-count');
    status.innerText = 'Fetching all garage rates...';
    
    try {
        // In a real system, we might have a dedicated /api/rates/aggregate endpoint
        // For this prototype, we'll fetch from all active garages
        const garages = PROTOTYPE_STATE.garages;
        const allRateRequests = garages.map(g => fetch(`${API_URL}/garages/${g.id}/rates`).then(r => r.json()));
        const results = await Promise.all(allRateRequests);
        
        const masterMap = {};
        results.flat().forEach(r => {
            const key = `${r.item}|${r.segment}`;
            if (!masterMap[key]) masterMap[key] = { cat: r.itemCategory, item: r.item, segment: r.segment, repair: [], replace: [], labor: [] };
            if (r.logicType === 'Repair') masterMap[key].repair.push(r.price);
            if (r.logicType === 'Replacement') masterMap[key].replace.push(r.price);
            if (r.logicType === 'Labor') masterMap[key].labor.push(r.price);
        });

        aggregatedRates = Object.values(masterMap);
        renderAggregatedRates();
        
        // Populate USP Summary
        const uspSummary = document.getElementById('usp-rate-summary');
        const segments = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];
        uspSummary.innerHTML = segments.map(seg => {
            const data = masterMap[`250-Point Health Report|${seg}`];
            const avg = data && data.labor.length ? Math.round(data.labor.reduce((a,b)=>a+b,0)/data.labor.length) : '-';
            return `
                <div style="text-align:center;">
                    <div style="font-size:0.65rem; color:var(--text-dim); text-transform:uppercase;">${seg}</div>
                    <div style="font-weight:700; color:var(--text-main);">₹${avg}</div>
                </div>
            `;
        }).join('');

        status.innerText = `Aggregated ${garages.length} Garages`;
    } catch (err) {
        status.innerText = 'Error loading rates';
        console.error(err);
    }
}

function renderAggregatedRates() {
    const tbody = document.getElementById('charge-rate-tbody');
    const search = document.getElementById('charge-rate-search').value.toLowerCase();
    const segment = document.getElementById('charge-rate-segment').value;

    const filtered = aggregatedRates.filter(r => {
        if (search && !r.item.toLowerCase().includes(search) && !r.cat.toLowerCase().includes(search)) return false;
        if (segment && r.segment !== segment) return false;
        return true;
    });

    tbody.innerHTML = filtered.map(r => {
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : '-';
        return `
            <tr>
                <td><span class="badge badge-secondary" style="font-size:0.6rem;">${r.cat.toUpperCase()}</span></td>
                <td style="font-weight:700;">${r.item}</td>
                <td><span class="badge ${r.segment === 'Universal' ? 'badge-secondary' : 'badge-primary'}" style="font-size:0.7rem;">${r.segment}</span></td>
                <td style="text-align: center; font-weight:600;">₹${avg(r.repair)}</td>
                <td style="text-align: center; font-weight:600;">₹${avg(r.replace)}</td>
                <td style="text-align: center; color:var(--primary); font-weight:700;">₹${avg(r.labor)}</td>
            </tr>
        `;
    }).join('');
}

async function openManageRatesModal(garageId) {
    const garage = PROTOTYPE_STATE.garages.find(g => g.id === garageId);
    if (!garage) return;

    try {
        const res = await fetch(`${API_URL}/garages/${garageId}/rates`);
        const savedRates = await res.json();
        const rMap = {};
        savedRates.forEach(r => rMap[`${r.item}|${r.segment}|${r.logicType}`] = r);

        const vType = garage.serviceType || 'Car';
        
        let displayList = [];
        const SEGMENTS = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];
        MASTER_CATALOG.forEach(it => {
            if (it.vType !== vType && vType !== 'Both') return;
            if (it.vType === 'Car') {
                SEGMENTS.forEach(seg => {
                    displayList.push({ ...it, segment: seg });
                });
            } else {
                displayList.push({ ...it, segment: 'Universal' });
            }
        });

        const groupedList = {};
        displayList.forEach(it => {
            if (!groupedList[it.cat]) groupedList[it.cat] = [];
            groupedList[it.cat].push(it);
        });

        const modalHtml = `
            <div class="modal-overlay open" id="modal-manage-rates">
                <div class="modal-content" style="max-width: 1000px; padding: 0; overflow: hidden; display: flex; flex-direction: column; max-height: 90vh;">
                    <div style="padding: 20px 25px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
                        <div>
                            <h2 style="margin:0; font-size:1.2rem;">Service Rate Management</h2>
                            <p style="margin: 4px 0 0 0; color: var(--text-dim); font-size: 0.8rem;">Setting separate rates by vehicle segment for <strong>${garage.name}</strong></p>
                        </div>
                        <button onclick="closeModal('modal-manage-rates')" class="btn btn-secondary" style="padding: 4px 8px;">✕</button>
                    </div>

                    <div style="flex: 1; overflow-y: auto; padding: 10px;">
                        <table style="font-size:0.85rem; width: 100%; border-collapse: collapse;">
                            <thead style="position: sticky; top: 0; background: var(--bg-card); z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
                                <tr>
                                    <th style="padding: 15px 10px 15px 30px; text-align: left; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Service Item</th>
                                    <th style="padding: 15px 10px; text-align: left; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Segment</th>
                                    <th style="padding: 15px 10px; text-align:center; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Repair (₹)</th>
                                    <th style="padding: 15px 10px; text-align:center; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Replace (₹)</th>
                                    <th style="padding: 15px 10px; text-align:center; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Labor (₹)</th>
                                    <th style="padding: 15px 10px; text-align:center; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px;">Warranty</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${Object.keys(groupedList).map(cat => `
                                    <tr style="background: rgba(255,255,255,0.03); border-top: 1px solid var(--border);">
                                        <td colspan="6" style="font-weight: 700; color: var(--primary); padding: 12px 15px; font-size: 0.85rem; letter-spacing: 1px; text-transform: uppercase;">
                                            <i data-lucide="layers" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: middle;"></i> ${cat}
                                        </td>
                                    </tr>
                                    ${groupedList[cat].map(it => {
                                        const key = `${it.item}|${it.segment}`;
                                        const repair = rMap[`${key}|Repair`]?.price || '';
                                        const replace = rMap[`${key}|Replacement`]?.price || '';
                                        const labor = rMap[`${key}|Labor`]?.price || '';
                                        const wDays = rMap[`${key}|Labor`]?.warrantyDays || '';
                                        const wKM = rMap[`${key}|Labor`]?.warrantyKM || '';

                                        // Refined Input Style
                                        const baseInpStyle = `height: 34px; width: 75px; text-align: center; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: var(--bg-surface); color: #fff; font-size: 0.85rem; outline: none;`;
                                        const disabledStyle = `opacity: 0.3; cursor: not-allowed; background: transparent; border-color: transparent;`;

                                        return `
                                            <tr class="rate-row" data-item="${it.item}" data-cat="${it.cat}" data-segment="${it.segment}" style="border-bottom: 1px solid rgba(255,255,255,0.01);">
                                                <td style="font-weight:600; padding-left: 30px; font-size:0.85rem;">${it.item}</td>
                                                <td><span class="badge ${it.segment === 'Universal' ? 'badge-secondary' : 'badge-primary'}" style="font-size:0.65rem; border:1px solid rgba(255,255,255,0.05);">${it.segment}</span></td>
                                                <td style="text-align:center;">
                                                    <input type="number" class="rate-input r-repair" value="${repair}" ${!it.canRepair ? 'disabled placeholder="-"' : 'placeholder="₹"'} style="${baseInpStyle} ${!it.canRepair ? disabledStyle : ''}">
                                                </td>
                                                <td style="text-align:center;">
                                                    <input type="number" class="rate-input r-replace" value="${replace}" ${!it.canReplace ? 'disabled placeholder="-"' : 'placeholder="₹"'} style="${baseInpStyle} ${!it.canReplace ? disabledStyle : ''}">
                                                </td>
                                                <td style="text-align:center;">
                                                    <input type="number" class="rate-input r-labor" value="${labor}" placeholder="₹" style="${baseInpStyle}">
                                                </td>
                                                <td style="text-align:center;">
                                                    <div style="display:flex; gap:4px; align-items:center; justify-content:center; background: rgba(255,255,255,0.02); padding: 4px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); width: max-content; margin: 0 auto;">
                                                        <input type="number" class="rate-input w-days" value="${wDays}" placeholder="Days" style="${baseInpStyle} width:55px; height: 26px; font-size:0.75rem; border-color:transparent; background: rgba(0,0,0,0.2);">
                                                        <span style="color:var(--text-dim); font-size:0.8rem;">/</span>
                                                        <input type="number" class="rate-input w-km" value="${wKM}" placeholder="KM" style="${baseInpStyle} width:55px; height: 26px; font-size:0.75rem; border-color:transparent; background: rgba(0,0,0,0.2);">
                                                    </div>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                `).join('')}
                            </tbody>
                        </table>
                    </div>

                    <div style="padding: 20px; border-top: 1px solid var(--border); text-align: right; background: rgba(255,255,255,0.02);">
                        <button onclick="closeModal('modal-manage-rates')" class="btn btn-secondary" style="margin-right: 10px;">Cancel</button>
                        <button onclick="saveGarageRates('${garageId}')" class="btn btn-primary">Publish Rates to Garage</button>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('modal-container').innerHTML = modalHtml;
        lucide.createIcons();
    } catch (err) {
        alert('Error loading rates: ' + err.message);
    }
}

async function saveGarageRates(garageId) {
    const rates = [];
    document.querySelectorAll('.rate-row').forEach(row => {
        const item = row.dataset.item;
        const cat = row.dataset.cat;
        const segment = row.dataset.segment;
        const wDays = row.querySelector('.w-days').value;
        const wKM = row.querySelector('.w-km').value;
        const vType = PROTOTYPE_STATE.garages.find(g => g.id === garageId)?.serviceType || 'Car';

        // Collect each logic type
        const repair = row.querySelector('.r-repair').value;
        const replace = row.querySelector('.r-replace').value;
        const labor = row.querySelector('.r-labor').value;

        if (repair) rates.push({ vType, cat, item, segment, logic: 'Repair', price: parseFloat(repair), wDays, wKM });
        if (replace) rates.push({ vType, cat, item, segment, logic: 'Replacement', price: parseFloat(replace), wDays, wKM });
        if (labor) rates.push({ vType, cat, item, segment, logic: 'Labor', price: parseFloat(labor), wDays, wKM });
    });

    try {
        const res = await fetch(`${API_URL}/garages/${garageId}/rates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rates })
        });
        if (!res.ok) throw new Error('Failed to save');
        
        alert('Rates updated successfully!');
        closeModal('modal-manage-rates');
        switchGarageTab('inventory', garageId); // Refresh the view
    } catch (err) {
        alert('Error saving rates: ' + err.message);
    }
}

function pushSKUToGarage(skuId) {
    const sku = PROTOTYPE_STATE.skus.find(s => s.id === skuId);
    if (!sku) return;

    // Filter only ACTIVE garages
    const activeGarages = PROTOTYPE_STATE.garages.filter(g => g.status === 'active');

    const modalHtml = `
        <div class="modal-overlay open" id="modal-push-sku">
            <div class="modal-content" style="max-width: 850px; max-height: 90vh; display: flex; flex-direction: column; background:#121212; border:1px solid #333; border-radius:16px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);">
                <div style="padding: 25px 30px; border-bottom: 1px solid #2a2a2a; background: rgba(255,255,255,0.02);">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <h2 style="margin:0; font-size:1.5rem; font-weight:700;">Distribute Part: <span style="color:var(--primary)">${sku.itemName}</span></h2>
                        <button onclick="closeModal('modal-push-sku')" style="background:none; border:none; color:var(--text-dim); cursor:pointer;"><i data-lucide="x" style="width:24px;"></i></button>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-top:25px; gap: 20px;">
                        <div class="form-group" style="margin:0; width:220px;">
                            <label style="font-size:0.75rem; color:var(--text-dim); font-weight:700; margin-bottom:8px; display:block; letter-spacing:0.5px;">REDRIVO PURCHASE PRICE</label>
                            <div style="position:relative;">
                                <span style="position:absolute; left:15px; top:10px; color:var(--primary); font-weight:700;">₹</span>
                                <input type="number" id="push-redrivo-price" class="input" value="${sku.vroomerPrice || 0}" style="padding-left:30px; border-color:var(--primary); font-size:1.1rem; font-weight:700; background:rgba(250, 204, 21, 0.05);">
                            </div>
                        </div>
                        <div style="flex:1; max-width: 400px; position:relative;">
                            <i data-lucide="search" style="position:absolute; left:15px; top:12px; width:18px; color:var(--text-dim);"></i>
                            <input type="text" placeholder="Search verified garages..." oninput="filterPushGarageList(this.value)" style="width:100%; background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:8px; color:#fff; font-size:0.95rem; padding:10px 15px 10px 45px; outline:none; transition: border-color 0.2s;">
                        </div>
                    </div>
                </div>
                
                <div style="flex:1; overflow-y:auto; padding:25px 30px; background: #0f0f0f;">
                    <div id="push-garage-list" style="display:grid; grid-template-columns: 1fr; gap:16px;">
                        ${activeGarages.map(g => `
                            <div class="push-garage-card" data-name="${g.name.toLowerCase()}" style="background:rgba(255,255,255,0.03); border:1px solid #2a2a2a; border-radius:12px; padding:20px; transition:0.2s;">
                                <div style="display:flex; flex-direction:column; gap:15px;">
                                    <label style="display:flex; align-items:center; gap:15px; cursor:pointer; width:100%;">
                                        <input type="checkbox" name="push-garage-ids" value="${g.id}" class="push-checkbox" style="width:22px; height:22px; accent-color:var(--primary); cursor:pointer;">
                                        <div>
                                            <div style="font-weight:700; font-size:1.1rem; color:#fff;">${g.name}</div>
                                            <div style="font-size:0.85rem; color:var(--text-dim); margin-top:2px;">${g.address || 'Verified Partner'}</div>
                                        </div>
                                    </label>
                                    <div class="push-controls" style="display:none; gap:20px; align-items:flex-start; background: rgba(0,0,0,0.3); padding: 20px; border-radius: 8px; border: 1px solid #222; margin-top: 5px;">
                                        <div style="width:130px;">
                                            <label style="font-size:0.7rem; color:var(--text-dim); font-weight:700; display:block; margin-bottom:8px; letter-spacing:0.5px;">STOCK TO ADD</label>
                                            <input type="number" class="push-stock-input" data-gid="${g.id}" value="5" style="width:100%; background:#1a1a1a; border:1px solid #333; color:#fff; padding:10px; border-radius:8px; font-size:1.1rem; font-weight:600; text-align:center;">
                                        </div>
                                        <div style="flex:1; width:100%;">
                                            <label style="font-size:0.7rem; color:var(--text-dim); font-weight:700; display:block; margin-bottom:8px; letter-spacing:0.5px;">SERIAL NUMBERS (Comma Separated)</label>
                                            <textarea class="push-serials-input" data-gid="${g.id}" placeholder="e.g. SN123, SN124..." style="width:100%; background:#1a1a1a; border:1px solid #333; color:var(--primary); padding:12px; border-radius:8px; font-size:0.95rem; min-height:60px; resize:vertical; font-family:monospace; line-height:1.4;"></textarea>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                        ${activeGarages.length === 0 ? `
                            <div style="text-align:center; padding:60px; background:rgba(255,255,255,0.01); border:1px dashed #333; border-radius:12px;">
                                <i data-lucide="alert-circle" style="width:40px; height:40px; color:var(--text-dim); margin-bottom:15px; opacity:0.5;"></i>
                                <h3 style="color:#fff; margin-bottom:5px;">No active garages</h3>
                                <p style="color:var(--text-dim); font-size:0.9rem;">There are currently no verified partners available for distribution.</p>
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div style="padding: 20px 30px; border-top: 1px solid #2a2a2a; display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.5); border-radius:0 0 16px 16px;">
                    <div id="push-selected-count" style="font-size:0.95rem; color:#fff; font-weight:600; display:flex; align-items:center; gap:8px;">
                        <span style="display:inline-block; width:8px; height:8px; background:var(--primary); border-radius:50%;"></span>
                        0 Garages Selected
                    </div>
                    <div style="display:flex; gap:15px;">
                        <button onclick="closeModal('modal-push-sku')" class="btn btn-secondary" style="border:none; padding:12px 24px; font-weight:600;">Cancel</button>
                        <button onclick="executeSKUPush('${skuId}')" class="btn btn-primary" style="padding: 12px 32px; font-weight:700; box-shadow: 0 4px 20px rgba(250, 204, 21, 0.25);">Distribute to Network</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modal-container').innerHTML = modalHtml;

    // Add event listener to show/hide controls
    document.querySelectorAll('.push-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const card = e.target.closest('.push-garage-card');
            const controls = card.querySelector('.push-controls');
            if (e.target.checked) {
                controls.style.display = 'flex';
                card.style.borderColor = 'var(--primary)';
                card.style.background = 'rgba(255,62,5,0.02)';
            } else {
                controls.style.display = 'none';
                card.style.borderColor = '#333';
                card.style.background = 'rgba(255,255,255,0.02)';
            }
            const count = document.querySelectorAll('.push-checkbox:checked').length;
            document.getElementById('push-selected-count').textContent = `${count} Garages Selected`;
        });
    });
}

function filterPushGarageList(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.push-garage-item').forEach(el => {
        el.style.display = el.dataset.name.includes(q) ? 'flex' : 'none';
    });
}

async function executeSKUPush(skuId) {
    const selectedCBs = document.querySelectorAll('.push-checkbox:checked');
    const redrivoPrice = parseFloat(document.getElementById('push-redrivo-price').value);

    if (selectedCBs.length === 0) return alert('Please select at least one garage.');

    const distributionItems = [];
    let totalStockToAdd = 0;

    for (const cb of selectedCBs) {
        const gid = cb.value;
        const stock = parseInt(document.querySelector(`.push-stock-input[data-gid="${gid}"]`).value) || 0;
        const serialsRaw = document.querySelector(`.push-serials-input[data-gid="${gid}"]`).value;
        const serials = serialsRaw.split(',').map(s => s.trim()).filter(s => s.length > 0);

        if (serials.length !== stock) {
            return alert(`Error for garage ${gid}: Stock (${stock}) must match number of Serial Numbers entered (${serials.length}).`);
        }

        distributionItems.push({ garageId: gid, redrivoPrice, stock, serials });
        totalStockToAdd += stock;
    }

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Processing Batch...';

    try {
        // 1. Bulk Serialized Parts Upload
        const serRes = await fetch(`${API_URL}/serialized-parts/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skuId, items: distributionItems.map(d => ({ garageId: d.garageId, serials: d.serials })) })
        });
        
        if (!serRes.ok) {
            const err = await serRes.json();
            throw new Error(err.error || 'Serial validation failed');
        }

        // 2. Activate SKUs for each garage
        for (const item of distributionItems) {
            await fetch(`${API_URL}/garages/${item.garageId}/skus`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    skuId, 
                    redrivoPrice: item.redrivoPrice, 
                    stock: item.stock, 
                    status: 'active' 
                })
            });
        }

        alert(`Successfully distributed ${totalStockToAdd} parts to ${distributionItems.length} garages.`);
        closeModal('modal-push-sku');
        renderSKUCatalog(document.getElementById('app'));
    } catch (err) {
        alert('Batch Distribution Failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Distribute to Network';
    }
}

// CRM Dispute Resolution Board
window.allDisputes = [];
window.selectedDisputeId = null;

window.renderDisputes = async function(container) {
    container.innerHTML = `
        <div class="header">
            <h1 class="page-title">Dispute Resolution Board</h1>
            <div style="font-size:0.8rem; color:var(--text-dim); margin-top:6px;">Resolve customer damage/reject reports and complaints.</div>
        </div>
        <div class="grid-12" style="margin-top: 20px; display: grid; grid-template-columns: 4fr 8fr; gap: 20px; align-items: start;">
            <div class="card" style="padding: 15px; margin: 0; min-height: 500px;">
                <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Pending Disputes</h3>
                <div id="dispute-list-container" style="display: flex; flex-direction: column; gap: 10px; max-height: 600px; overflow-y: auto;">
                    Loading disputes...
                </div>
            </div>
            <div class="card" id="dispute-detail-container" style="padding: 20px; margin: 0; min-height: 500px; display: flex; flex-direction: column; justify-content: center; align-items: center; color: var(--text-muted);">
                Select a dispute from the left panel to review details.
            </div>
        </div>
    `;

    try {
        const res = await fetch(`${API_URL}/disputes`);
        if (res.ok) {
            window.allDisputes = await res.json();
            window.renderDisputeList();
            if (window.allDisputes.length > 0) {
                window.selectDispute(window.allDisputes[0].id);
            } else {
                document.getElementById('dispute-detail-container').innerHTML = `
                    <div style="text-align: center; padding: 40px;">
                        <i data-lucide="shield-check" style="width: 48px; height: 48px; color: var(--success); margin-bottom: 15px;"></i>
                        <h4 style="color:#fff;">All Clear!</h4>
                        <p style="font-size:0.9rem; color:var(--text-muted); margin-top:5px;">No active driver disputes or support complaints found.</p>
                    </div>
                `;
                lucide.createIcons();
            }
        } else {
            document.getElementById('dispute-list-container').innerHTML = 'Failed to load disputes.';
        }
    } catch (err) {
        document.getElementById('dispute-list-container').innerHTML = 'Connection error loading disputes.';
    }
};

window.renderDisputeList = function() {
    const container = document.getElementById('dispute-list-container');
    if (!container) return;

    if (window.allDisputes.length === 0) {
        container.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">No disputes.</div>';
        return;
    }

    container.innerHTML = window.allDisputes.map(d => {
        const activeClass = d.id === window.selectedDisputeId ? 'style="border: 1px solid var(--primary); background: rgba(245, 158, 11, 0.05);"' : 'style="border: 1px solid var(--border);"';
        const badgeColor = d.status === 'pending' ? 'badge-warning' : (d.status === 'dismissed' ? 'badge-success' : 'badge-danger');
        
        return `
            <div onclick="selectDispute('${d.id}')" class="list-item-card" ${activeClass} style="padding: 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <strong style="color:#fff; font-size:0.85rem;">Trip #${(d.tripid || d.tripId || '').slice(-8)}</strong>
                    <span class="badge ${badgeColor}" style="font-size:0.65rem;">${d.status.toUpperCase()}</span>
                </div>
                <div style="font-size:0.75rem; color:var(--text-dim); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
                    ${d.reason}
                </div>
                <div style="font-size:0.7rem; color:var(--text-muted); margin-top:8px; display:flex; justify-content:space-between;">
                    <span>Driver: ${d.marshal_name || 'N/A'}</span>
                    <span>${new Date(d.createdat || d.createdAt).toLocaleDateString()}</span>
                </div>
            </div>
        `;
    }).join('');
};

window.selectDispute = async function(id) {
    window.selectedDisputeId = id;
    window.renderDisputeList();

    const d = window.allDisputes.find(item => item.id === id);
    const container = document.getElementById('dispute-detail-container');
    if (!d || !container) return;

    container.innerHTML = `
        <div style="width: 100%;">
            <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                <div>
                    <h2 style="color:#fff; margin:0; font-size:1.2rem;">Dispute Resolution Details</h2>
                    <span style="font-size:0.8rem; color:var(--text-dim);">Trip ID: ${d.tripid || d.tripId}</span>
                </div>
                <span class="badge ${d.status === 'pending' ? 'badge-warning' : (d.status === 'dismissed' ? 'badge-success' : 'badge-danger')}" style="padding:6px 12px; font-size:0.8rem;">
                    ${d.status.toUpperCase()}
                </span>
            </div>

            <div class="grid-2" style="gap: 15px; margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr;">
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); padding: 12px; border-radius: 8px;">
                    <span style="font-size: 0.7rem; color: var(--text-dim); display:block; text-transform:uppercase;">Customer Details</span>
                    <strong style="color:#fff; font-size:0.9rem;">${d.customer_name || 'N/A'}</strong>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">Trip Origin: ${d.pickup_address || 'N/A'}</div>
                </div>
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); padding: 12px; border-radius: 8px;">
                    <span style="font-size: 0.7rem; color: var(--text-dim); display:block; text-transform:uppercase;">Driver Details</span>
                    <strong style="color:#fff; font-size:0.9rem;">${d.marshal_name || 'N/A'}</strong>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">Phone: ${d.marshal_phone || 'N/A'}</div>
                </div>
            </div>

            <div class="card" style="border-left: 4px solid var(--danger); background: rgba(239,68,68,0.05); padding:15px; margin-bottom: 20px;">
                <span style="font-size:0.75rem; color:var(--danger); font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Customer Complaint Details</span>
                <p style="color:#fff; font-size:0.9rem; margin-top:6px; line-height:1.4;">${d.reason}</p>
            </div>

            <h3 style="color:#fff; font-size:0.95rem; margin-bottom:10px;">Side-by-Side Condition Audit Review</h3>
            <div class="grid-2" id="dispute-audit-media" style="gap: 20px; display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 25px;">
                <div class="card" style="padding: 10px; margin: 0; background: var(--bg-surface);">
                    <h4 style="text-align: center; margin-bottom: 8px; color: var(--primary);">Origin State Audit</h4>
                    <div id="origin-media-container" style="min-height:150px; display:flex; align-items:center; justify-content:center; background:#121212; border-radius:6px; color:var(--text-dim); font-size:0.8rem;">
                        Loading Origin Media...
                    </div>
                </div>
                <div class="card" style="padding: 10px; margin: 0; background: var(--bg-surface);">
                    <h4 style="text-align: center; margin-bottom: 8px; color: #22c55e;">Destination Handover Audit</h4>
                    <div id="dest-media-container" style="min-height:150px; display:flex; align-items:center; justify-content:center; background:#121212; border-radius:6px; color:var(--text-dim); font-size:0.8rem;">
                        Loading Destination Media...
                    </div>
                </div>
            </div>

            ${d.status === 'pending' ? `
                <div style="border-top:1px solid var(--border); padding-top:20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:15px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="color:#fff; font-size:0.85rem; font-weight:600;">Deduction Amount (₹):</span>
                        <input type="number" id="dispute-penalty-amount" class="input" style="width:120px; height:38px;" value="200" min="0">
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button class="btn btn-secondary" onclick="resolveDispute('${d.id}', 'dismissed')" style="padding:10px 20px;"><i data-lucide="check"></i> Dismiss Dispute</button>
                        <button class="btn btn-danger" onclick="resolveDispute('${d.id}', 'penalized')" style="padding:10px 20px;"><i data-lucide="slash"></i> Penalize Driver</button>
                    </div>
                </div>
            ` : `
                <div style="border-top:1px solid var(--border); padding-top:15px; font-size:0.9rem; color:var(--text-dim); text-align:center;">
                    Resolved as <strong style="color:#fff;">${d.status.toUpperCase()}</strong> ${d.deductionamount || d.deductionAmount ? `with a deduction of <strong>₹${d.deductionamount || d.deductionAmount}</strong>` : ''}
                </div>
            `}
        </div>
    `;
    if (window.lucide) lucide.createIcons();

    // Fetch media associated with the trip
    try {
        const tripId = d.tripid || d.tripId;
        const mediaRes = await fetch(`${API_URL}/media?referenceId=${tripId}`);
        if (mediaRes.ok) {
            const mediaList = await mediaRes.json();
            const originContainer = document.getElementById('origin-media-container');
            const destContainer = document.getElementById('dest-media-container');

            const originMedia = mediaList.filter(m => m.doctype === '360_pickup' || m.doctype === 'odometer_start' || (m.doctype && m.doctype.includes('pickup')));
            const destMedia = mediaList.filter(m => m.doctype === '360_delivery' || m.doctype === 'odometer_end' || (m.doctype && m.doctype.includes('delivery')) || (m.doctype && m.doctype.includes('dropoff')));

            const renderMediaElement = (m) => {
                const path = m.filepath || m.filePath;
                const isVideo = path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.mov') || path.includes('video');
                const fullUrl = path.startsWith('http') ? path : `${API_URL.substring(0, API_URL.lastIndexOf('/api'))}/${path}`;
                if (isVideo) {
                    return `<video src="${fullUrl}" controls style="width:100%; border-radius:4px; max-height:220px; background:#000;"></video>`;
                } else {
                    return `<img src="${fullUrl}" style="width:100%; border-radius:4px; max-height:220px; object-fit:contain; background:#000;">`;
                }
            };

            if (originContainer) {
                if (originMedia.length > 0) {
                    originContainer.innerHTML = `<div style="display:flex; flex-direction:column; gap:10px; width:100%;">${originMedia.map(m => renderMediaElement(m)).join('')}</div>`;
                } else {
                    originContainer.innerHTML = 'No Origin Media Found';
                }
            }

            if (destContainer) {
                if (destMedia.length > 0) {
                    destContainer.innerHTML = `<div style="display:flex; flex-direction:column; gap:10px; width:100%;">${destMedia.map(m => renderMediaElement(m)).join('')}</div>`;
                } else {
                    destContainer.innerHTML = 'No Destination Media Found';
                }
            }
        }
    } catch (err) {
        console.warn('Error loading media details', err);
    }
};

window.resolveDispute = async function(id, action) {
    const penaltyInput = document.getElementById('dispute-penalty-amount');
    const deductionAmount = penaltyInput ? parseFloat(penaltyInput.value || 0) : 0;

    if (action === 'penalized' && (isNaN(deductionAmount) || deductionAmount <= 0)) {
        alert('Please enter a valid positive penalty deduction amount.');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/disputes/${id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, deductionAmount })
        });

        if (res.ok) {
            alert(`Dispute resolved successfully as ${action.toUpperCase()}`);
            window.renderDisputes(document.getElementById('app'));
        } else {
            const data = await res.json();
            alert(data.error || 'Failed to resolve dispute');
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

async function renderBackendSurveys(container) {
    container.innerHTML = '<div style="padding:40px;text-align:center;">Loading surveys...</div>';
    try {
        const res = await fetch(`${API_URL}/feedback`);
        if (!res.ok) throw new Error('Failed to fetch surveys');
        const surveys = await res.json();
        
        let html = '<div class="header"><h1 class="page-title">Survey Feedback Database</h1></div>';
        html += '<div style="display:flex; flex-direction:column; gap: 16px; margin-top:20px;">';
        
        if (surveys.length === 0) {
            html += '<div class="card">No feedback received yet.</div>';
        } else {
            surveys.forEach(s => {
                html += '<div class="card" style="border-left: 4px solid var(--primary);">';
                html += '<div style="display:flex; justify-content:space-between; margin-bottom:12px;">';
                html += '<span style="font-weight:bold; color:var(--text-main);">' + (s.userRole ? s.userRole.toUpperCase() : 'UNKNOWN') + ' - ' + (s.surveyType ? s.surveyType.toUpperCase() : 'SURVEY') + '</span>';
                html += '<span style="font-size:0.8rem; color:var(--text-muted);">' + new Date(s.createdAt || Date.now()).toLocaleString() + '</span>';
                html += '</div>';
                
                for(let i=1; i<=6; i++) {
                    const q = s['question'+i];
                    const a = s['answer'+i];
                    if(q && a) {
                        html += '<div style="margin-bottom:8px; font-size:0.9rem;">';
                        html += '<strong style="color:var(--text-muted);">Q: ' + q + '</strong><br>';
                        html += '<span style="color:var(--success);">A: ' + a + '</span>';
                        html += '</div>';
                    }
                }
                
                html += '</div>';
            });
        }
        
        html += '</div>';
        container.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    } catch(err) {
        container.innerHTML = '<div class="card" style="color:var(--danger);">Error loading surveys: ' + err.message + '</div>';
    }
}

async function renderIncentives(container) {
    try {
        window._driverOpsTab = window._driverOpsTab || 'withdrawals';
        window._incentiveVehicleType = window._incentiveVehicleType || 'car';
        window._withdrawalTab = window._withdrawalTab || 'requested';

        let withdrawalsList = [];
        let pendingCount = 0;
        try {
            const [wRes, countRes, sysRes, slabsRes, globalRes, ratesRes] = await Promise.all([
                fetch(`${API_URL}/admin/withdrawals?status=${window._withdrawalTab}`).catch(() => null),
                fetch(`${API_URL}/admin/withdrawals?status=requested`).catch(() => null),
                fetch(`${API_URL}/system-settings`).catch(() => null),
                fetch(`${API_URL}/settings/incentives`).catch(() => null),
                fetch(`${API_URL}/settings/global`).catch(() => null),
                fetch(`${API_URL}/payout-model-rates`).catch(() => null)
            ]);

            if (wRes && wRes.ok) {
                withdrawalsList = await wRes.json();
            }
            if (countRes && countRes.ok) {
                const pendingList = await countRes.json();
                pendingCount = pendingList.length;
            }
            if (sysRes && sysRes.ok) {
                window._sysSettings = await sysRes.json();
            }
            if (slabsRes && slabsRes.ok) {
                const slabsData = await slabsRes.json();
                if (Array.isArray(slabsData) && slabsData.length > 0) {
                    window._currentSlabs = slabsData.map(s => ({
                        maxDistance: Number(s.maxDistance !== undefined ? s.maxDistance : s.maxdistance),
                        ratePerKm: Number(s.ratePerKm !== undefined ? s.ratePerKm : s.rateperkm)
                    }));
                }
            }
            if (globalRes && globalRes.ok) {
                window._globalSettings = await globalRes.json();
            }
            if (ratesRes && ratesRes.ok) {
                const ratesData = await ratesRes.json();
                if (ratesData && ratesData.rates) window._payoutRates = ratesData.rates;
            }
        } catch (eWdr) {
            console.error("Failed to load settings/withdrawals in renderIncentives:", eWdr);
        }

        if (!window._currentSlabs) {
            window._currentSlabs = [
                { maxDistance: 5, ratePerKm: 40 },
                { maxDistance: 10, ratePerKm: 30 },
                { maxDistance: 15, ratePerKm: 35 }
            ];
        }
        if (!window._globalSettings) {
            window._globalSettings = { five_star_bonus: 50, payout_days: 3 };
        }
        if (!window._payoutRates) {
            window._payoutRates = {
                commissionRatePercent: 20.0,
                subscriptionDailyPrice: 99.00,
                subscriptionWeeklyPrice: 499.00,
                subscriptionMonthlyPrice: 1499.00,
                subscriptionAnnualPrice: 14999.00,
                demandSearchWeight: 1.0,
                demandBookingWeight: 3.0
            };
        }
        if (window._slabsEditMode === undefined) window._slabsEditMode = false;
        if (window._globalEditMode === undefined) window._globalEditMode = false;
        if (window._payoutRatesEditMode === undefined) window._payoutRatesEditMode = false;

        const renderSlabsUI = () => {
            let html = '<div class="header"><h1 class="page-title">Driver Operations & Fare Engine</h1></div>';
            
            // Master Navigation Sub-Tabs
            html += `
            <div class="tabs" style="display:flex; gap:10px; margin-top:20px; border-bottom:1px solid var(--border); padding-bottom:14px; margin-bottom: 24px; flex-wrap:wrap;">
                <button class="tab-btn ${window._driverOpsTab === 'withdrawals' ? 'active' : ''}" onclick="window._driverOpsTab='withdrawals'; renderIncentives(document.getElementById('app'))" style="padding:10px 18px; font-weight:700; border-radius:8px; border:none; cursor:pointer; background:${window._driverOpsTab === 'withdrawals' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._driverOpsTab === 'withdrawals' ? '#000' : '#fff'}; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s;">
                    <i data-lucide="banknote" style="width:16px; height:16px;"></i> Withdrawal Requests
                    ${pendingCount > 0 ? `<span style="background:#EF4444; color:#fff; font-size:0.75rem; padding:2px 7px; border-radius:10px; font-weight:800;">${pendingCount}</span>` : ''}
                </button>
                <button class="tab-btn ${window._driverOpsTab === 'slabs' ? 'active' : ''}" onclick="window._driverOpsTab='slabs'; renderIncentives(document.getElementById('app'))" style="padding:10px 18px; font-weight:700; border-radius:8px; border:none; cursor:pointer; background:${window._driverOpsTab === 'slabs' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._driverOpsTab === 'slabs' ? '#000' : '#fff'}; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s;">
                    <i data-lucide="tag" style="width:16px; height:16px;"></i> Distance Rate Slabs
                </button>
                <button class="tab-btn ${window._driverOpsTab === 'fare_rules' ? 'active' : ''}" onclick="window._driverOpsTab='fare_rules'; renderIncentives(document.getElementById('app'))" style="padding:10px 18px; font-weight:700; border-radius:8px; border:none; cursor:pointer; background:${window._driverOpsTab === 'fare_rules' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._driverOpsTab === 'fare_rules' ? '#000' : '#fff'}; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s;">
                    <i data-lucide="sliders" style="width:16px; height:16px;"></i> Base Fares & Payout Rules
                </button>
                <button class="tab-btn ${window._driverOpsTab === 'pricing_model' ? 'active' : ''}" onclick="window._driverOpsTab='pricing_model'; renderIncentives(document.getElementById('app'))" style="padding:10px 18px; font-weight:700; border-radius:8px; border:none; cursor:pointer; background:${window._driverOpsTab === 'pricing_model' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._driverOpsTab === 'pricing_model' ? '#000' : '#fff'}; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s;">
                    <i data-lucide="percent" style="width:16px; height:16px;"></i> Commission & Subscriptions
                </button>
            </div>
            `;

            // TAB 1: WITHDRAWALS QUEUE
            if (window._driverOpsTab === 'withdrawals') {
                html += `
                <div class="card" style="margin-top: 0; margin-bottom: 24px; border: 1px solid rgba(250,204,21,0.25);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px;">
                        <div>
                            <h2 style="margin:0; font-size:1.2rem; color:#fff; display:flex; align-items:center; gap:8px;">
                                <i data-lucide="banknote" style="color:var(--primary); width:20px;"></i> Driver Withdrawal Requests (Manual Payouts)
                            </h2>
                            <p style="font-size:0.82rem; color:var(--text-muted); margin:4px 0 0 0;">
                                Review driver payout requests. Transfer funds via your banking/UPI portal, then enter the transaction UTR reference number to mark as paid.
                            </p>
                        </div>
                        <button onclick="renderIncentives(document.getElementById('app'))" class="btn btn-secondary btn-sm" style="display:inline-flex; align-items:center; gap:6px;">
                            <i data-lucide="refresh-cw" style="width:14px; height:14px;"></i> Refresh
                        </button>
                    </div>

                    <div style="display:flex; gap:8px; border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:15px; flex-wrap:wrap;">
                        <button class="btn btn-sm ${window._withdrawalTab === 'requested' ? 'btn-primary' : 'btn-secondary'}" onclick="window._withdrawalTab='requested'; renderIncentives(document.getElementById('app'))" style="font-weight:700;">
                            Pending Approval (${pendingCount})
                        </button>
                        <button class="btn btn-sm ${window._withdrawalTab === 'completed' ? 'btn-primary' : 'btn-secondary'}" onclick="window._withdrawalTab='completed'; renderIncentives(document.getElementById('app'))" style="font-weight:700;">
                            Completed Payouts
                        </button>
                        <button class="btn btn-sm ${window._withdrawalTab === 'rejected' ? 'btn-primary' : 'btn-secondary'}" onclick="window._withdrawalTab='rejected'; renderIncentives(document.getElementById('app'))" style="font-weight:700;">
                            Rejected
                        </button>
                        <button class="btn btn-sm ${window._withdrawalTab === 'all' ? 'btn-primary' : 'btn-secondary'}" onclick="window._withdrawalTab='all'; renderIncentives(document.getElementById('app'))" style="font-weight:700;">
                            All Requests
                        </button>
                    </div>

                    <div style="overflow-x:auto;">
                        <table style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr style="border-bottom:1px solid var(--border); text-align:left; font-size:0.78rem; color:var(--text-muted); text-transform:uppercase;">
                                    <th style="padding:10px;">Date & ID</th>
                                    <th style="padding:10px;">Driver Details</th>
                                    <th style="padding:10px;">Amount</th>
                                    <th style="padding:10px;">Destination Bank / UPI</th>
                                    <th style="padding:10px;">Status</th>
                                    <th style="padding:10px; text-align:center;">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                `;

                if (withdrawalsList && withdrawalsList.length > 0) {
                    withdrawalsList.forEach(w => {
                        let statusBadge = '';
                        if (w.status === 'requested') {
                            statusBadge = '<span class="badge" style="background:rgba(250,204,21,0.15); color:#FACC15; border:1px solid rgba(250,204,21,0.3); font-weight:700;">PENDING</span>';
                        } else if (w.status === 'completed') {
                            statusBadge = `<span class="badge" style="background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); font-weight:700;">PAID (UTR: ${w.utr_number || 'N/A'})</span>`;
                        } else if (w.status === 'rejected') {
                            statusBadge = `<span class="badge" style="background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); font-weight:700;">REJECTED</span>`;
                        }

                        const dateStr = new Date(w.created_at).toLocaleDateString() + ' ' + new Date(w.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

                        html += `
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.85rem;">
                                <td style="padding:10px;">
                                    <div style="font-weight:700; color:#fff;">${dateStr}</div>
                                    <div style="font-size:0.72rem; color:var(--text-muted); font-family:monospace;">${w.id}</div>
                                </td>
                                <td style="padding:10px;">
                                    <div style="font-weight:700; color:#fff;">${w.driver_name || w.driver_id}</div>
                                    <div style="font-size:0.75rem; color:var(--text-muted);">${w.driver_phone || ''}</div>
                                </td>
                                <td style="padding:10px;">
                                    <div style="font-size:1.1rem; font-weight:800; color:var(--primary);">₹${w.amount}</div>
                                </td>
                                <td style="padding:10px;">
                                    ${w.account_number ? `
                                        <div style="font-weight:600; color:#fff;">${w.bank_name || 'Bank'}</div>
                                        <div style="font-size:0.78rem; color:#a1a1aa; font-family:monospace;">A/C: ${w.account_number} • IFSC: ${w.ifsc_code}</div>
                                        <div style="font-size:0.72rem; color:var(--text-muted);">Name: ${w.account_holder_name || 'N/A'}</div>
                                    ` : `
                                        <div style="color:#FACC15; font-weight:700;">UPI: ${w.upi_id || 'N/A'}</div>
                                    `}
                                </td>
                                <td style="padding:10px;">
                                    ${statusBadge}
                                    ${w.rejection_reason ? `<div style="font-size:0.72rem; color:#ef4444; margin-top:2px;">${w.rejection_reason}</div>` : ''}
                                    ${w.admin_notes ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">Note: ${w.admin_notes}</div>` : ''}
                                </td>
                                <td style="padding:10px; text-align:center;">
                                    ${w.status === 'requested' ? `
                                        <div style="display:flex; gap:6px; justify-content:center;">
                                            <button class="btn btn-sm" onclick="openMarkPaidModal('${w.id}', '${w.amount}', '${(w.driver_name || w.account_holder_name || '').replace(/'/g, "\\'")}', '${w.account_number || ''}', '${w.ifsc_code || ''}', '${(w.bank_name || '').replace(/'/g, "\\'")}', '${w.upi_id || ''}')" style="background:var(--success); color:#fff; border:none; padding:5px 10px; border-radius:6px; font-weight:700; cursor:pointer;">
                                                <i data-lucide="check" style="width:14px; height:14px; vertical-align:middle;"></i> Mark Paid
                                            </button>
                                            <button class="btn btn-danger btn-sm" onclick="openRejectWithdrawalModal('${w.id}', '${w.amount}', '${(w.driver_name || '').replace(/'/g, "\\'")}')" style="padding:5px 10px; border-radius:6px; font-weight:700; cursor:pointer;">
                                                <i data-lucide="x" style="width:14px; height:14px; vertical-align:middle;"></i> Reject
                                            </button>
                                        </div>
                                    ` : `
                                        <span style="color:var(--text-muted); font-size:0.78rem;">Settled</span>
                                    `}
                                </td>
                            </tr>
                        `;
                    });
                } else {
                    html += `
                        <tr>
                            <td colspan="6" style="padding:30px; text-align:center; color:var(--text-muted); font-size:0.88rem;">
                                No withdrawal requests found in this view.
                            </td>
                        </tr>
                    `;
                }

                html += `
                            </tbody>
                        </table>
                    </div>
                </div>
                `;
            }

            // TAB 2: DISTANCE RATE SLABS
            else if (window._driverOpsTab === 'slabs') {
                html += `
                <div class="card" style="margin-top:0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px;">
                        <div>
                            <h2 style="margin:0; color:var(--text-main); font-size:1.2rem;">Distance Rate Slabs</h2>
                            <p style="font-size:0.85rem; color:var(--text-muted); margin:4px 0 0 0;">Configure the payout rate per KM based on total trip distance. Evaluated in ascending order of Max Distance.</p>
                        </div>

                        <div style="display:flex; gap:8px;">
                            <button class="tab-btn ${window._incentiveVehicleType === 'car' ? 'active' : ''}" onclick="window._incentiveVehicleType='car'; renderIncentives(document.getElementById('app'))" style="padding:8px 16px; font-weight:700; border-radius:6px; border:none; cursor:pointer; background:${window._incentiveVehicleType === 'car' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._incentiveVehicleType === 'car' ? '#000' : '#fff'};">
                                🚗 Car Slabs
                            </button>
                            <button class="tab-btn ${window._incentiveVehicleType === 'bike' ? 'active' : ''}" onclick="window._incentiveVehicleType='bike'; renderIncentives(document.getElementById('app'))" style="padding:8px 16px; font-weight:700; border-radius:6px; border:none; cursor:pointer; background:${window._incentiveVehicleType === 'bike' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._incentiveVehicleType === 'bike' ? '#000' : '#fff'};">
                                🏍️ Bike Slabs
                            </button>
                        </div>
                    </div>

                    <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                        <thead>
                            <tr style="border-bottom:1px solid var(--border); text-align:left; font-size:0.8rem; color:var(--text-muted); text-transform:uppercase;">
                                <th style="padding:10px;">From (KM)</th>
                                <th style="padding:10px;">To (KM)</th>
                                <th style="padding:10px;">Driver Payout Rate (₹/KM)</th>
                                ${window._slabsEditMode ? '<th style="text-align:center; padding:10px;">Action</th>' : ''}
                            </tr>
                        </thead>
                        <tbody>
                `;

                window._currentSlabs.forEach((slab, index) => {
                    let fromVal = 0.0;
                    if (index > 0) {
                        fromVal = (Number(window._currentSlabs[index - 1].maxDistance) + 0.1).toFixed(1);
                    }
                    const disabledAttr = window._slabsEditMode ? '' : 'disabled';
                    html += `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                            <td style="padding:10px; color:var(--text-muted); font-weight:600;">${fromVal} KM</td>
                            <td style="padding:10px;"><input type="number" value="${slab.maxDistance}" onchange="window._currentSlabs[${index}].maxDistance=Number(this.value); window.drawIncentivesUI()" ${disabledAttr} style="width:120px; padding:8px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px;"></td>
                            <td style="padding:10px;"><input type="number" value="${slab.ratePerKm}" onchange="window._currentSlabs[${index}].ratePerKm=Number(this.value)" ${disabledAttr} style="width:120px; padding:8px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700; color:var(--primary);"></td>
                            ${window._slabsEditMode ? `<td style="padding:10px; text-align:center;"><button onclick="window._currentSlabs.splice(${index}, 1); window.drawIncentivesUI()" style="background:var(--danger); color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer;">Remove</button></td>` : ''}
                        </tr>
                    `;
                });

                html += `
                        </tbody>
                    </table>

                    <div style="display:flex; gap:10px;">
                        ${window._slabsEditMode ? `
                            <button onclick="window._currentSlabs.push({maxDistance: 999, ratePerKm: 30}); window.drawIncentivesUI()" class="btn-secondary" style="padding:10px 16px; border-radius:6px;">+ Add Slab</button>
                            <button onclick="saveIncentives()" class="btn-primary" style="padding:10px 20px; background:var(--success); border:none; color:#fff; font-weight:700; border-radius:6px;">Save Slabs</button>
                        ` : `
                            <button onclick="window._slabsEditMode=true; window.drawIncentivesUI()" class="btn-secondary" style="padding:10px 20px; border-radius:6px; font-weight:700;">Edit Slabs</button>
                        `}
                    </div>
                </div>
                `;
            }

            // TAB 3: BASE FARES & PAYOUT RULES
            else if (window._driverOpsTab === 'fare_rules') {
                const disabledGlobal = window._globalEditMode ? '' : 'disabled';
                const type = window._incentiveVehicleType;
                const bonusKey = `${type}_five_star_bonus`;
                const payoutKey = `${type}_payout_days`;
                const baseFareKey = `${type}_base_fare`;
                const maxPickupKey = `${type}_max_pickup_distance_km`;
                const custRateKey = `${type}_customer_rate_per_km`;
                const haltKey = `${type}_halt_rate_per_min`;
                const hourlyKey = `${type}_hourly_rate`;

                const bonusVal = window._sysSettings?.[bonusKey] !== undefined ? window._sysSettings[bonusKey] : (window._globalSettings?.[bonusKey] !== undefined ? window._globalSettings[bonusKey] : (type === 'car' ? 50 : 30));
                const payoutVal = window._sysSettings?.[payoutKey] !== undefined ? window._sysSettings[payoutKey] : (window._globalSettings?.[payoutKey] !== undefined ? window._globalSettings[payoutKey] : 3);
                const baseFareVal = window._sysSettings?.[baseFareKey] !== undefined ? window._sysSettings[baseFareKey] : (window._globalSettings?.[baseFareKey] !== undefined ? window._globalSettings[baseFareKey] : (type === 'car' ? 150 : 50));
                const maxPickupVal = window._sysSettings?.[maxPickupKey] !== undefined ? window._sysSettings[maxPickupKey] : 10.0;
                const custRateVal = window._sysSettings?.[custRateKey] !== undefined ? window._sysSettings[custRateKey] : (type === 'car' ? 30.0 : 8.0);
                const haltVal = window._sysSettings?.[haltKey] !== undefined ? window._sysSettings[haltKey] : (window._globalSettings?.[haltKey] !== undefined ? window._globalSettings[haltKey] : (type === 'car' ? 5 : 3));
                const hourlyVal = window._sysSettings?.[hourlyKey] !== undefined ? window._sysSettings[hourlyKey] : (window._globalSettings?.[hourlyKey] !== undefined ? window._globalSettings[hourlyKey] : (type === 'car' ? 150 : 80));

                html += `
                <div class="card" style="margin-top:0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px;">
                        <div>
                            <h2 style="margin:0; color:var(--text-main); font-size:1.2rem;">Base Fares & Operational Payout Rules</h2>
                            <p style="font-size:0.85rem; color:var(--text-muted); margin:4px 0 0 0;">Platform-wide minimums, bonus incentives, and logistics dispatch constraints.</p>
                        </div>

                        <div style="display:flex; gap:8px;">
                            <button class="tab-btn ${window._incentiveVehicleType === 'car' ? 'active' : ''}" onclick="window._incentiveVehicleType='car'; renderIncentives(document.getElementById('app'))" style="padding:8px 16px; font-weight:700; border-radius:6px; border:none; cursor:pointer; background:${window._incentiveVehicleType === 'car' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._incentiveVehicleType === 'car' ? '#000' : '#fff'};">
                                🚗 Car Rules
                            </button>
                            <button class="tab-btn ${window._incentiveVehicleType === 'bike' ? 'active' : ''}" onclick="window._incentiveVehicleType='bike'; renderIncentives(document.getElementById('app'))" style="padding:8px 16px; font-weight:700; border-radius:6px; border:none; cursor:pointer; background:${window._incentiveVehicleType === 'bike' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; color:${window._incentiveVehicleType === 'bike' ? '#000' : '#fff'};">
                                🏍️ Bike Rules
                            </button>
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:20px; margin-bottom:24px;">
                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Minimum Base Fare (₹)</label>
                            <input type="number" id="global-base-fare" value="${baseFareVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Starting threshold for any booking</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Customer Rate per KM (₹/KM)</label>
                            <input type="number" step="0.1" id="global-customer-rate-per-km" value="${custRateVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Customer distance rate multiplier</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">5-Star Rating Bonus (₹)</label>
                            <input type="number" id="global-bonus" value="${bonusVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Direct cash bonus for 5-star customer reviews</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Maximum Pickup Distance (KM)</label>
                            <input type="number" step="0.1" id="global-max-pickup-distance" value="${maxPickupVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Maximum radius for auto-dispatch</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Halt Rate per Minute (₹/min)</label>
                            <input type="number" step="1" id="global-halt-rate-per-min" value="${haltVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Waiting charge during en-route stops</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Hourly Rental Rate (₹/Hour)</label>
                            <input type="number" step="1" id="global-hourly-rate" value="${hourlyVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Hourly booking base rate</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Payout Clearance Window (Days)</label>
                            <input type="number" id="global-payout" value="${payoutVal}" ${disabledGlobal} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Settlement grace period</span>
                        </div>
                    </div>

                    <div>
                        ${window._globalEditMode ? `
                            <button onclick="saveGlobalSettings()" class="btn-primary" style="padding:10px 20px; background:var(--success); border:none; color:#fff; border-radius:6px; font-weight:700; cursor:pointer;">Save Global Rules</button>
                        ` : `
                            <button onclick="window._globalEditMode=true; window.drawIncentivesUI()" class="btn-secondary" style="padding:10px 20px; border-radius:6px; font-weight:700; cursor:pointer;">Edit Rules</button>
                        `}
                    </div>
                </div>
                `;
            }

            // TAB 4: COMMISSION & SUBSCRIPTIONS
            else if (window._driverOpsTab === 'pricing_model') {
                const disabledPayout = window._payoutRatesEditMode ? '' : 'disabled';
                html += `
                <div class="card" style="margin-top:0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <div>
                            <h2 style="margin:0; color:var(--text-main); font-size:1.2rem;">Dual Payout Model & Subscription Plans</h2>
                            <p style="font-size:0.85rem; color:var(--text-muted); margin:4px 0 0 0;">Configure the commission % cut per trip and flat-fee subscription pricing for drivers.</p>
                        </div>
                        <span class="badge" style="background: rgba(250,204,21,0.1); color:#FACC15; border:1px solid rgba(250,204,21,0.3); padding:4px 10px; border-radius:6px; font-weight:700; font-size:0.75rem;">Driver Monetization</span>
                    </div>

                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:18px; margin-bottom:24px;">
                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Platform Commission Cut (%)</label>
                            <input type="number" step="0.1" id="crm-rate-commission" value="${window._payoutRates.commissionRatePercent}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700; color:var(--primary);">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Deducted from gross trip fare</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Daily Pass (₹)</label>
                            <input type="number" step="1" id="crm-rate-daily" value="${window._payoutRates.subscriptionDailyPrice}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">24-hour unlimited pass</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Weekly Pass (₹)</label>
                            <input type="number" step="1" id="crm-rate-weekly" value="${window._payoutRates.subscriptionWeeklyPrice}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">7-day unlimited pass</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Monthly Pass (₹)</label>
                            <input type="number" step="1" id="crm-rate-monthly" value="${window._payoutRates.subscriptionMonthlyPrice}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">30-day calendar cycle</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Annual Pass (₹)</label>
                            <input type="number" step="1" id="crm-rate-annual" value="${window._payoutRates.subscriptionAnnualPrice}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">365-day full pass</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Demand Search Weight (x)</label>
                            <input type="number" step="0.1" id="crm-rate-search-weight" value="${window._payoutRates.demandSearchWeight !== undefined ? window._payoutRates.demandSearchWeight : 1.0}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Surge multiplier per search</span>
                        </div>

                        <div>
                            <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:6px; font-weight:600;">Demand Booking Weight (x)</label>
                            <input type="number" step="0.1" id="crm-rate-booking-weight" value="${window._payoutRates.demandBookingWeight !== undefined ? window._payoutRates.demandBookingWeight : 3.0}" ${disabledPayout} style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:#fff; border-radius:6px; font-weight:700;">
                            <span style="font-size:0.72rem; color:var(--text-dim); margin-top:4px; display:block;">Surge multiplier per booking</span>
                        </div>
                    </div>

                    <div>
                        ${window._payoutRatesEditMode ? `
                            <button onclick="savePayoutRates()" class="btn-primary" style="padding:10px 20px; background:var(--success); border:none; color:#fff; border-radius:6px; font-weight:700; cursor:pointer;">Save Payout Rates</button>
                        ` : `
                            <button onclick="window._payoutRatesEditMode=true; window.drawIncentivesUI()" class="btn-secondary" style="padding:10px 20px; border-radius:6px; font-weight:700; cursor:pointer;">Edit Rates</button>
                        `}
                    </div>
                </div>
                `;
            }
            
            container.innerHTML = html;
            if (window.lucide) lucide.createIcons();
        };

        window.savePayoutRates = async function() {
            const commission = document.getElementById('crm-rate-commission').value;
            const daily = document.getElementById('crm-rate-daily').value;
            const weekly = document.getElementById('crm-rate-weekly').value;
            const monthly = document.getElementById('crm-rate-monthly').value;
            const annual = document.getElementById('crm-rate-annual').value;
            const searchWeight = document.getElementById('crm-rate-search-weight')?.value || 1.0;
            const bookingWeight = document.getElementById('crm-rate-booking-weight')?.value || 3.0;

            try {
                const res = await fetch(`${API_URL}/admin/payout-rates`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        commissionRatePercent: commission,
                        subscriptionDailyPrice: daily,
                        subscriptionWeeklyPrice: weekly,
                        subscriptionMonthlyPrice: monthly,
                        subscriptionAnnualPrice: annual,
                        demandSearchWeight: searchWeight,
                        demandBookingWeight: bookingWeight
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    window._payoutRates = data.rates;
                    window._payoutRatesEditMode = false;

                    alert('Payout model rates updated successfully!');
                    renderIncentives(container);
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert('Failed to update rates: ' + (err.error || res.statusText));
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };

        window.saveGlobalSettings = async function() {
            const bonus = document.getElementById('global-bonus').value;
            const payout = document.getElementById('global-payout').value;
            const baseFare = document.getElementById('global-base-fare').value;
            const maxPickupDist = document.getElementById('global-max-pickup-distance').value;
            const customerRatePerKm = document.getElementById('global-customer-rate-per-km').value;
            const haltRate = document.getElementById('global-halt-rate-per-min').value;
            const hourlyRate = document.getElementById('global-hourly-rate').value;
            
            const type = window._incentiveVehicleType;
            
            try {
                const res1 = await fetch(`${API_URL}/settings/global`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ settings: [
                        { key: `${type}_five_star_bonus`, value: bonus },
                        { key: `${type}_payout_days`, value: payout },
                        { key: `${type}_base_fare`, value: baseFare },
                        { key: `${type}_halt_rate_per_min`, value: haltRate },
                        { key: `${type}_hourly_rate`, value: hourlyRate }
                    ]})
                });
                
                const res2 = await fetch(`${API_URL}/system-settings`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ key: `${type}_max_pickup_distance_km`, value: maxPickupDist })
                });

                const res3 = await fetch(`${API_URL}/system-settings`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ key: `${type}_customer_rate_per_km`, value: customerRatePerKm })
                });

                if(res1.ok && res2.ok && res3.ok) {
                    window._globalEditMode = false;
                    alert('Global settings saved successfully!');
                    renderIncentives(container);
                } else {
                    alert('Failed to save settings.');
                }
            } catch(e) {
                alert('Error: ' + e.message);
            }
        };
        
        window.saveIncentives = async function() {
            window._currentSlabs.sort((a,b) => a.maxDistance - b.maxDistance);
            try {
                const sres = await fetch(`${API_URL}/settings/incentives`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ 
                        slabs: window._currentSlabs,
                        type: window._incentiveVehicleType 
                    })
                });
                if(sres.ok) {
                    window._slabsEditMode = false;
                    alert('Incentive settings saved successfully!');
                    renderIncentives(container);
                } else {
                    alert('Failed to save settings.');
                }
            } catch(e) {
                alert('Error: ' + e.message);
            }
        };

        window.drawIncentivesUI = renderSlabsUI;
        renderSlabsUI();
        
    } catch(err) {
        container.innerHTML = '<div class="card" style="color:var(--danger);">Error loading incentives: ' + err.message + '</div>';
    }
}




window.deleteUser = async function(id) {
    if (!confirm('WARNING: Under the Indian Digital Personal Data Protection Act (DPDP), this action will permanently delete or anonymize this user\'s data. Proceed?')) return;
    try {
        const res = await fetch(`${API_URL}/users/${id}`, { method: 'DELETE' });
        if (res.ok) {
            alert('User data permanently deleted/anonymized.');
            renderUsers();
        } else {
            alert('Failed to delete user data.');
        }
    } catch(e) {
        console.error('Delete error:', e);
        alert('Network error while deleting user.');
    }
};

window.openMarkPaidModal = function(id, amount, driverName, accNum, ifsc, bankName, upiId) {
    const modalHtml = `
        <div class="modal-backdrop" style="position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;">
            <div class="card" style="max-width:500px; width:100%; background:#18181b; border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:20px; box-shadow:0 10px 40px rgba(0,0,0,0.8);">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:15px;">
                    <h3 style="margin:0; font-size:1.1rem; color:#fff; display:flex; align-items:center; gap:8px;">
                        <i data-lucide="check-circle" style="color:var(--success);"></i> Confirm Payout Sent
                    </h3>
                    <button onclick="closeCrmModal()" style="background:none; border:none; color:#a1a1aa; font-size:1.4rem; cursor:pointer;">&times;</button>
                </div>

                <div style="background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.25); border-radius:8px; padding:12px; margin-bottom:15px; text-align:center;">
                    <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Payout Amount</div>
                    <div style="font-size:1.8rem; font-weight:900; color:var(--success); margin-top:2px;">₹${amount}</div>
                </div>

                <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:15px;">
                    <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700; margin-bottom:6px; text-transform:uppercase;">Driver Beneficiary Details:</div>
                    <div style="font-weight:700; color:#fff; font-size:0.95rem;">${driverName}</div>
                    <div style="color:#a1a1aa; font-size:0.82rem; margin-top:3px;">Bank: <b style="color:#fff;">${bankName || 'N/A'}</b></div>
                    <div style="color:#a1a1aa; font-size:0.82rem;">A/C Number: <b style="font-family:monospace; color:#FACC15;">${accNum || 'N/A'}</b></div>
                    <div style="color:#a1a1aa; font-size:0.82rem;">IFSC Code: <b style="font-family:monospace; color:#fff;">${ifsc || 'N/A'}</b></div>
                    ${upiId ? `<div style="color:#a1a1aa; font-size:0.82rem; margin-top:2px;">UPI ID: <b style="color:#FACC15;">${upiId}</b></div>` : ''}
                </div>

                <div style="margin-bottom:15px;">
                    <label style="display:block; font-size:0.8rem; font-weight:700; color:#fff; margin-bottom:5px;">
                        Bank Transfer Reference / UTR Number <span style="color:var(--danger);">*</span>
                    </label>
                    <input type="text" id="payout-utr-input" placeholder="e.g. UTR98237192837 or IMPS ref" style="width:100%; padding:10px; background:rgba(0,0,0,0.4); border:1px solid var(--border); color:#fff; border-radius:6px; font-size:0.9rem;">
                </div>

                <div style="margin-bottom:15px;">
                    <label style="display:block; font-size:0.8rem; font-weight:700; color:var(--text-muted); margin-bottom:5px;">
                        Admin Notes (Optional)
                    </label>
                    <input type="text" id="payout-notes-input" placeholder="e.g. Sent via HDFC NetBanking" style="width:100%; padding:10px; background:rgba(0,0,0,0.4); border:1px solid var(--border); color:#fff; border-radius:6px; font-size:0.85rem;">
                </div>

                <div style="display:flex; gap:10px;">
                    <button onclick="closeCrmModal()" class="btn btn-secondary" style="flex:1;">Cancel</button>
                    <button onclick="submitMarkPaid('${id}')" class="btn btn-primary" style="flex:1; background:var(--success); border:none; color:#fff; font-weight:700;">Confirm Payout Sent</button>
                </div>
            </div>
        </div>
    `;
    let modalEl = document.getElementById('crm-modal-host');
    if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.id = 'crm-modal-host';
        document.body.appendChild(modalEl);
    }
    modalEl.innerHTML = modalHtml;
    if (window.lucide) lucide.createIcons();
};

window.openRejectWithdrawalModal = function(id, amount, driverName) {
    const modalHtml = `
        <div class="modal-backdrop" style="position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;">
            <div class="card" style="max-width:450px; width:100%; background:#18181b; border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:20px; box-shadow:0 10px 40px rgba(0,0,0,0.8);">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:15px;">
                    <h3 style="margin:0; font-size:1.1rem; color:var(--danger); display:flex; align-items:center; gap:8px;">
                        <i data-lucide="x-circle" style="color:var(--danger);"></i> Reject Withdrawal Request
                    </h3>
                    <button onclick="closeCrmModal()" style="background:none; border:none; color:#a1a1aa; font-size:1.4rem; cursor:pointer;">&times;</button>
                </div>

                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:15px;">
                    Rejecting this request will restore <b style="color:var(--primary);">₹${amount}</b> back to <b>${driverName}</b>'s available wallet balance.
                </p>

                <div style="margin-bottom:15px;">
                    <label style="display:block; font-size:0.8rem; font-weight:700; color:#fff; margin-bottom:5px;">
                        Reason for Rejection <span style="color:var(--danger);">*</span>
                    </label>
                    <select id="payout-reject-reason-select" onchange="if(this.value==='other'){document.getElementById('payout-reject-custom').style.display='block';}else{document.getElementById('payout-reject-custom').style.display='none';}" style="width:100%; padding:10px; background:rgba(0,0,0,0.4); border:1px solid var(--border); color:#fff; border-radius:6px; font-size:0.85rem; margin-bottom:8px;">
                        <option value="Bank account number invalid / returned beneficiary error">Bank account number invalid / returned error</option>
                        <option value="IFSC code does not match bank branch">IFSC code does not match bank branch</option>
                        <option value="Beneficiary account name mismatch with KYC">Beneficiary account name mismatch with KYC</option>
                        <option value="Driver requested cancellation of payout">Driver requested cancellation</option>
                        <option value="other">Other reason (Type below)</option>
                    </select>
                    <input type="text" id="payout-reject-custom" placeholder="Specify custom reason..." style="display:none; width:100%; padding:10px; background:rgba(0,0,0,0.4); border:1px solid var(--border); color:#fff; border-radius:6px; font-size:0.85rem;">
                </div>

                <div style="display:flex; gap:10px;">
                    <button onclick="closeCrmModal()" class="btn btn-secondary" style="flex:1;">Cancel</button>
                    <button onclick="submitRejectWithdrawal('${id}')" class="btn btn-danger" style="flex:1; font-weight:700;">Confirm Rejection</button>
                </div>
            </div>
        </div>
    `;
    let modalEl = document.getElementById('crm-modal-host');
    if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.id = 'crm-modal-host';
        document.body.appendChild(modalEl);
    }
    modalEl.innerHTML = modalHtml;
    if (window.lucide) lucide.createIcons();
};

window.closeCrmModal = function() {
    const modalEl = document.getElementById('crm-modal-host');
    if (modalEl) modalEl.innerHTML = '';
};

window.submitMarkPaid = async function(id) {
    const utr = document.getElementById('payout-utr-input')?.value;
    const notes = document.getElementById('payout-notes-input')?.value;

    if (!utr || utr.trim() === '') {
        alert('Please enter the Bank UTR / Transaction Reference Number.');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/withdrawals/${id}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ utrNumber: utr, adminNotes: notes })
        });
        const data = await res.json();
        if (res.ok) {
            closeCrmModal();
            alert('Payout marked as completed successfully!');
            renderIncentives(document.getElementById('app'));
        } else {
            alert(data.error || 'Failed to complete payout.');
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

window.submitRejectWithdrawal = async function(id) {
    const select = document.getElementById('payout-reject-reason-select');
    let reason = select?.value;
    if (reason === 'other') {
        reason = document.getElementById('payout-reject-custom')?.value;
    }

    if (!reason || reason.trim() === '') {
        alert('Please select or specify a rejection reason.');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/withdrawals/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (res.ok) {
            closeCrmModal();
            alert('Withdrawal rejected. Balance has been restored to the driver.');
            renderIncentives(document.getElementById('app'));
        } else {
            alert(data.error || 'Failed to reject withdrawal.');
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
};
