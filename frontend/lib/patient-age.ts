/** Age is based on the clinic's calendar date in India, not the UTC date. */
export function patientAge(value: string | null, now = new Date()): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Not provided";
  const birth = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== value || Number.isNaN(now.getTime())) return "Not provided";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value);
  const year = part("year"), month = part("month"), day = part("day");
  const birthYear = birth.getUTCFullYear(), birthMonth = birth.getUTCMonth() + 1, birthDay = birth.getUTCDate();
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age--;
  return age < 0 ? "Not provided" : String(age);
}
