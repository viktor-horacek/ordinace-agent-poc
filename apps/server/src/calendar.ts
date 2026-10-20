// Krok 8.1: smyšlený kalendář ordinace. Žádná databáze, jen pravidla v kódu.
// Kalendář sahá 14 dní od dneška (dva týdny), ordinuje se v pondělí až pátek 8:00–16:00,
// sloty po 20 minutách. Obsazené časy jsou pevné podle dne v týdnu, takže výsledek jde předvídat
// a kalendář nezastará (neplatí jen pro jedno konkrétní datum).
// Krok 10: navíc objednávky z nástroje book_appointment, jen v paměti procesu (restart je smaže).

const DAYS_AHEAD = 14;
const SLOT_MINUTES = 20; // minut
const OPEN = 8 * 60; // 8:00 v minutách od půlnoci
const CLOSE = 16 * 60; // 16:00, poslední slot začíná 15:40

// obsazené začátky slotů podle dne v týdnu (1 = pondělí … 5 = pátek), stejné v obou týdnech
const BOOKED: Record<number, string[]> = {
  1: ['08:00', '08:20', '08:40', '09:00', '10:20', '13:00', '13:20', '15:40'],
  2: ['08:00', '08:20', '08:40', '09:00', '09:20', '11:00', '14:40'], // úterý ráno odběry do 9:40
  3: ['08:00', '10:00', '10:20', '10:40', '12:00', '12:20', '12:40'],
  4: ['08:20', '08:40', '09:40', '13:00', '13:20', '13:40', '14:00', '14:20'],
  5: ['08:00', '08:20', '09:00', '11:20', '11:40'],
};

// objednávky z book_appointment: klíč „YYYY-MM-DD HH:MM“, hodnota id pacienta
const bookings = new Map<string, string>();

/** Datum ve formátu YYYY-MM-DD podle místního času (toISOString by dal UTC a kolem půlnoci jiný den). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Posun data o n dní. Počítá v UTC, ať změna letního času neposune den. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Nejbližší daný den v týdnu po dni `from` (2 = úterý). Z úterka vrátí úterý za týden. */
export function nextWeekday(from: string, weekday: number): string {
  const current = new Date(`${from}T00:00:00Z`).getUTCDay();
  return addDays(from, (weekday - current + 7) % 7 || 7);
}

/**
 * Volné začátky slotů pro jeden den, např. ['08:40', '09:00', …]. O víkendu prázdné pole.
 * Datum mimo kalendář je výjimka: o tom, jak ji ukázat modelu, rozhoduje volající (tools.ts).
 */
export function findFreeSlots(date: string): string[] {
  const from = todayIso();
  const to = addDays(from, DAYS_AHEAD - 1);
  // YYYY-MM-DD jde porovnávat jako řetězce
  if (date < from || date > to) {
    throw new Error(`Kalendář je jen od ${from} do ${to}`);
  }

  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = neděle, 6 = sobota
  if (weekday === 0 || weekday === 6) return [];

  const free: string[] = [];
  for (let min = OPEN; min < CLOSE; min += SLOT_MINUTES) {
    const time = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    if (!BOOKED[weekday]?.includes(time) && !bookings.has(`${date} ${time}`)) free.push(time);
  }
  return free;
}

/**
 * Krok 10: zapíše pacienta na volný slot, potom ho findFreeSlots už nevrátí.
 * Obsazený nebo neexistující slot (třeba 9:10) je výjimka, stejně jako datum mimo kalendář.
 */
export function bookAppointment(patientId: string, date: string, time: string): void {
  if (!findFreeSlots(date).includes(time)) {
    throw new Error(`Termín ${date} ${time} není volný`);
  }
  bookings.set(`${date} ${time}`, patientId);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
