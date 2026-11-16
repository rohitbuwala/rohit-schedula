export type AssistantLanguage = 'en' | 'hi';

// Resolve scheduling vocabulary locally. Never send names or raw Hindi text to
// the intent provider; AssistantService still applies its fixed-word allowlist.
export function normalizeSchedulingMessage(message: string): string {
  const terms: [RegExp, string][] = [
    [/आने\s*वाली|आगामी/gu, ' upcoming '],
    [/अपॉइंटमेंट(?:्स)?|अपोइंटमेंट(?:्स)?|एपॉइंटमेंट(?:्स)?|नियुक्ति/gu, ' appointment '],
    [/बुकिंग/gu, ' booking '], [/मरीज़|मरीज|पेशेंट|रोगी/gu, ' patient '],
    [/मेरी|मेरा|मेरे/gu, ' my '], [/अगली|अगला|अगले/gu, ' next '],
    [/उपलब्ध|खाली/gu, ' available '], [/स्लॉट/gu, ' slot '],
    [/आज/gu, ' today '], [/कल/gu, ' tomorrow '],
    [/कब/gu, ' when '], [/कौन/gu, ' who '],
    [/दिखाओ|दिखाएं|बताओ|बताएं/gu, ' show '],
    [/पिछली|पिछला|पिछले|पुरानी/gu, ' past '],
    [/रद्द|कैंसिल/gu, ' cancel '], [/बदलना|बदलें|बदलो/gu, ' change '],
    [/बुक\s*(?:करो|करें|करना)/gu, ' book '],
  ];
  return terms.reduce((text, [pattern, value]) => text.replace(pattern, value), message);
}

const hindiReplies: Record<string, string> = {
  'Here are your upcoming appointments.': 'ये आपकी आने वाली अपॉइंटमेंट हैं। नीचे नाम, तारीख और समय देखें।',
  'You have no upcoming appointments.': 'आपकी कोई आने वाली अपॉइंटमेंट नहीं है।',
  "Here are today's appointments.": 'ये आज की आपकी अपॉइंटमेंट हैं।',
  'You have no appointments today.': 'आज आपकी कोई अपॉइंटमेंट नहीं है।',
  'Here are your appointments for that date.': 'ये चुनी हुई तारीख की आपकी अपॉइंटमेंट हैं।',
  'You have no appointments on that date.': 'इस तारीख को आपकी कोई अपॉइंटमेंट नहीं है।',
  'Here is your next available slot.': 'यह आपका अगला खाली समय है। यह पहले से बुक की गई अपॉइंटमेंट नहीं है।',
  'Here are your appointments.': 'ये आपकी अपॉइंटमेंट हैं।',
  'You have no appointments.': 'आपकी कोई अपॉइंटमेंट नहीं है।',
  'Here are your past appointments.': 'ये आपकी पिछली अपॉइंटमेंट हैं।',
  'You have no past appointments.': 'आपकी कोई पिछली अपॉइंटमेंट नहीं है।',
  'Here are the appointment details.': 'ये अपॉइंटमेंट की जानकारी है।',
  'Here is your schedule.': 'यह आपका काम करने का शेड्यूल है।',
  'Here are your appointment statistics.': 'ये आपकी अपॉइंटमेंट के आँकड़े हैं।',
  'Here are the matching doctors.': 'ये आपकी खोज से मेल खाने वाले डॉक्टर हैं।',
  'No matching doctors found.': 'आपकी खोज से मेल खाने वाला डॉक्टर नहीं मिला।',
  'Which doctor or specialty should I look for?': 'आप किस डॉक्टर या विशेषज्ञता को खोजना चाहते हैं?',
  'Here are the available slots.': 'ये उपलब्ध समय हैं।',
  'There are no open slots for that date.': 'इस तारीख को कोई खाली समय उपलब्ध नहीं है।',
  'Your requested slot is available.': 'आपका चुना हुआ समय उपलब्ध है।',
  'Enter today, tomorrow, or one date in YYYY-MM-DD format.': 'आज, कल या YYYY-MM-DD के रूप में एक तारीख बताएं।',
  'Enter one date in YYYY-MM-DD format to check availability.': 'उपलब्ध समय देखने के लिए YYYY-MM-DD के रूप में एक तारीख बताएं।',
  'Here is your payment and refund history.': 'यह आपके भुगतान और रिफंड का विवरण है।',
  'You have no payments on file.': 'आपका कोई भुगतान दर्ज नहीं है।',
  'Here are your prescriptions.': 'ये आपके प्रिस्क्रिप्शन हैं।',
  'You have no prescriptions on file.': 'आपका कोई प्रिस्क्रिप्शन दर्ज नहीं है।',
};

export function localizeAssistantReply<T extends { tool: string; reply: string }>(result: T, language: AssistantLanguage): T {
  if (language === 'en') return result;
  let reply = hindiReplies[result.reply];
  if (!reply && result.tool === 'start_booking') reply = 'बुकिंग का ड्राफ्ट तैयार है। कृपया डॉक्टर, तारीख और उपलब्ध समय चुनकर विवरण जाँचें।';
  if (!reply && result.tool === 'next_available_slot') reply = 'खोज की अवधि में कोई खाली समय नहीं मिला।';
  if (!reply && result.tool === 'clarify') reply = 'कृपया अपना सवाल स्पष्ट करें। मैं आपकी अपॉइंटमेंट, तारीख, शेड्यूल और उपलब्ध समय की जानकारी दिखा सकता हूँ। बदलाव करने के लिए संबंधित विकल्प चुनें और पुष्टि करें।';
  // Keep structured results unchanged; never translate patient names or IDs.
  return { ...result, reply: reply ?? 'आपके अनुरोध की जानकारी नीचे दी गई है।' };
}
