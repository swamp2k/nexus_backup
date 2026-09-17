const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function nextScheduleAt(scheduleValue, timezoneValue, afterValue) {
  const schedule = normalizeSchedule(scheduleValue);
  const timezone = normalizeTimezone(timezoneValue);
  const after = afterValue instanceof Date ? new Date(afterValue) : new Date(afterValue);
  if (!Number.isFinite(after.getTime())) throw new RangeError("after must be a valid date");

  const local = zonedParts(after, timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const localDate = addCalendarDays(local.year, local.month, local.day, offset);
    if (schedule.kind === "weekly" && !schedule.days.includes(localDate.weekday)) continue;
    const candidate = resolveZonedLocal({
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hour,
      minute,
    }, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("Unable to calculate next backup schedule");
}

function normalizeSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("schedule must be an object");
  const kind = value.kind;
  if (kind !== "daily" && kind !== "weekly") throw new RangeError("schedule.kind must be daily or weekly");
  const time = requireString(value.time, "schedule.time", 5, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("schedule.time must be HH:MM");
  if (kind === "daily") return { kind, time };
  if (!Array.isArray(value.days) || value.days.length === 0) throw new RangeError("weekly schedules require at least one day");
  const unique = new Set();
  for (const day of value.days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError("schedule.days must contain weekday numbers 0-6");
    unique.add(day);
  }
  return { kind, time, days: WEEKDAY_ORDER.filter((day) => unique.has(day)) };
}

function normalizeTimezone(value) {
  const timezone = requireString(value, "timezone", 1, 100);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new RangeError(`invalid timezone: ${timezone}`); }
  return timezone;
}

function resolveZonedLocal(target, timezone) {
  for (let bump = 0; bump <= 120; bump += 1) {
    const shifted = new Date(Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute + bump));
    const desired = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
    const exact = resolveExactZonedLocal(desired, timezone);
    if (exact) return exact;
  }
  throw new Error(`Unable to resolve scheduled local time in ${timezone}`);
}

function resolveExactZonedLocal(target, timezone) {
  const targetMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0, 0);
  let guess = targetMs;
  for (let index = 0; index < 6; index += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const representedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const delta = targetMs - representedMs;
    if (delta === 0 && matchesTarget(parts, target)) return new Date(guess);
    guess += delta;
  }
  const parts = zonedParts(new Date(guess), timezone);
  return matchesTarget(parts, target) ? new Date(guess) : null;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(values.year), month = Number(values.month), day = Number(values.day);
  return { year, month, day, hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function addCalendarDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function matchesTarget(parts, target) {
  return parts.year === target.year && parts.month === target.month && parts.day === target.day && parts.hour === target.hour && parts.minute === target.minute;
}

function requireString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return normalized;
}
