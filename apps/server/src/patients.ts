// Krok 9.1: smyšlení pacienti ordinace. Jména jsou vymyšlená, data jen tolik, kolik nástroj potřebuje
// (jméno a rok narození na rozlišení dvou lidí se stejným příjmením).

export type Patient = { id: string; name: string; birthYear: number };

const PATIENTS: Patient[] = [
  { id: 'p1', name: 'Jana Dvořáková', birthYear: 1968 },
  { id: 'p2', name: 'Petr Svoboda', birthYear: 1983 },
  { id: 'p3', name: 'Marie Nováková', birthYear: 1951 },
  { id: 'p4', name: 'Tomáš Kučera', birthYear: 1990 },
  { id: 'p5', name: 'Eva Procházková', birthYear: 1975 },
];

/** Pacienti, jejichž jméno obsahuje hledaný text; nezáleží na velikosti písmen ani diakritice. */
export function findPatients(query: string): Patient[] {
  const q = normalize(query);
  return PATIENTS.filter((p) => normalize(p.name).includes(q));
}

// „Dvořáková“ → „dvorakova“: NFD rozdělí á na a + čárku, čárky (U+0300–U+036F) pak smažeme
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
