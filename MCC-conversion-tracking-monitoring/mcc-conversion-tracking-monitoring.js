/**
 * Név: MCC – Konverziómérés figyelő + 30 napos trend riport (v3.0)
 * Cél:
 * 1) Több fiókban (MCC) ellenőrzi a konverziók és konverziós értékek számát X napos ablakban,
 *    és jelzi, ha az elvárt küszöb alá esik. Támogatja a “TELJES FIÓK” sort is.
 * 2) (Opcionális) Trend riport: a Beállítások fülben megadott konverziókhoz 30 napos napi bontású
 *    táblát + 1 chartot készít fiókonként külön fülre, blokkokat egymás alá rakva, és kiírja a minimumokat is.
 *
 * Támogatott “Konverziómérés típusa” értékek (fix stringek):
 * - Conversions                       → metrics.conversions, metrics.conversions_value
 * - All conversions                   → metrics.all_conversions, metrics.all_conversions_value
 * - Conversions by conv. time         → metrics.conversions_by_conversion_date, metrics.conversions_value_by_conversion_date
 * - All conversions by conv. time     → metrics.all_conversions_by_conversion_date, metrics.all_conversions_value_by_conversion_date
 *
 * Használat:
 * 1) Google Sheet létrehozása - másold a template sheetet:
 *    https://docs.google.com/spreadsheets/d/1iv1VMcLpIHhhg9qaHKUH--Jn19Qt5AtJe2N6WWv6zFk/copy
 *
 * 2) Alább állítsd be: SHEET_URL és (opcionálisan) EMAIL_RECIPIENTS.
 * 3) Trend riporthoz: ENABLE_TREND_REPORT kapcsoló.
 *
 * Fontos:
 * - Nem szűrünk primary_for_goal szerint. A „Conversions” oszlop logikáját a Google kezeli;
 *   mi csak azt választjuk ki, melyik oszlop(-pár)ból olvasunk.
 * - GAQL BETWEEN, tegnapig záró dátummal, fiók időzónájában értelmezett napokra.
 * - A dateRange() időzóna-biztos: a napok számítását UTC-ben végezzük, hogy ne csússzon.
 *
 * Copyright © 2025 Bognár Klára
 * Minden jog fenntartva.
 * Impresszió Online Marketing
 * https://impresszio.hu
 *
 * Köszönet a közreműködésért:-)
 * - Google Ads Script Sensei © Nils Rooijmans
 * - Antigravity + Claude Sonnet 4.5
 */

// =======================
// ==== KONFIGURÁCIÓ ====
// =======================

// Kötelező: a beállító sheet URL-je
const SHEET_URL = 'IDE_MÁSOLD_A_GOOGLE_SHEET_URL_CÍMÉT';

// E-mail cím(ek) – mindig küldünk összefoglalót (OK esetben is)
const EMAIL_RECIPIENTS = 'email@example.com';

// „Konverziómérés típusa” elfogadott értékek (fix stringek)
const MEASUREMENT_TYPES = {
  CONV: 'Conversions',
  ALL: 'All conversions',
  CONV_TIME: 'Conversions by conv. time',
  ALL_TIME: 'All conversions by conv. time'
};

// Trend riport (30 napos napi bontás) – minimumok belövéséhez
const ENABLE_TREND_REPORT = true;       // Kapcsoló: true = trend fülek + chartok készülnek
const TREND_DAYS = 30;                  // Hány napot mutasson (tegnapig)
const TREND_SHEET_PREFIX = 'Trend - ';  // Fül név prefix fiókonként
const CLEAR_TREND_TABS_ON_RUN = true;   // true = futáskor a trend fülek ürítése/újraépítése

// Logolási limit (mintanév-listákhoz)
const LOG_SAMPLE_LIMIT = 5;

// Fülnevek
const SETTINGS_SHEET_NAME = 'Beállítások';
const RESULTS_SHEET_NAME = 'Eredmények';

// Speciális kulcsszó fiók-összesítéshez
const ACCOUNT_TOTAL_KEYWORD = 'TELJES FIÓK';

// Dátum-ablak felső korlát biztonságból (nap)
const MAX_LOOKBACK_DAYS = 90;

// E-mailben maximum ennyi sort mutatunk (hibák / eltérések külön-külön)
const MAX_ROWS_IN_EMAIL = 200;

// Elvárt oszlopok a Beállítások fülön (validáláshoz)
const EXPECTED_HEADERS = [
  'Fiókazonosító',
  'Ügyfélnév',
  'Konverziómérés típusa',
  'Konverziós művelet',
  'Napok',
  'Elvárt konverziók',
  'Elvárt konverziós érték',
  'Engedélyezve'
];

// Sor-színezéshez (fiókonként váltakozó háttér)
let lastShadingAccountId = null;
let lastShadingIsGrey = false; // false → fehér, true → világosszürke

// =======================
// ======= MAIN =========
// =======================

function main() {
  console.log('--- Konverziómérés figyelő indul ---');
  validateConfig();

  const { settingsSheet, resultsSheet } = getSheets();
  const configRows = readConfig(settingsSheet);

  if (!configRows.length) {
    console.log('Nincs feldolgozható sor.');
    writeResultsHeader(resultsSheet); // üres táblával is konzisztens
    writeStatusEmail([], [], true, false);
    console.log('--- Kész (üres konfiguráció) ---');
    return;
  }

  writeResultsHeader(resultsSheet);

  // Sorok fiókonként csoportosítva
  const grouped = groupByAccount(configRows);

  // Beállítások szerinti fióksorrend (első előfordulás)
  const accountOrder = [];
  const seen = {};
  for (const row of configRows) {
    const id = normalizeId(row.id);
    if (!seen[id]) { seen[id] = true; accountOrder.push(id); }
  }

  // Elérhető fiókok lekérdezése MCC alatt
  const accIter = AdsManagerApp.accounts().withIds(accountOrder).get();
  const accountMap = {};
  const availableIdMap = {};
  while (accIter.hasNext()) {
    const acc = accIter.next();
    const id = normalizeId(acc.getCustomerId());
    accountMap[id] = acc;
    availableIdMap[id] = true;
  }

  // Feldolgozási sorrend: Beállítások szerinti, de csak a valóban elérhető fiókok
  const accounts = accountOrder
    .filter(id => !!accountMap[id])
    .map(id => accountMap[id]);

  const deviationRows = []; // BELOW_* státuszok
  const errorRows = [];     // ERROR státuszok

  // Fiókok feldolgozása
  for (const acc of accounts) {
    const id = normalizeId(acc.getCustomerId());
    const rows = grouped[id] || [];
    console.log(`\n>>> ${formatId(id)} | ${acc.getName()} (${rows.length} szabály)`);

    try {
      AdsManagerApp.select(acc);

      // Meta (név/státusz)
      const meta = fetchConversionMeta(buildConversionMetaQuery());
      const nameIndex = buildNameIndex(meta); // csak ENABLED index

      // Csak az érvényes Napokkal rendelkező sorok mennek a cache-be
      const validRowsForDays = rows.filter(r => !r.hasMissingDays && !r.hasInvalidDays);
      const daySets = uniqueDays(validRowsForDays);
      const cacheByDays = {}; // { days: { [MEASUREMENT_TYPES.*]: { byName, total } } }

      for (const d of daySets) {
        const range = dateRange(d);
        const metricsMap = fetchMetrics(buildMetricsQuery(range.start, range.end));
        cacheByDays[d] = {};
        cacheByDays[d][MEASUREMENT_TYPES.CONV] = aggregate(metricsMap, meta, 'conv');
        cacheByDays[d][MEASUREMENT_TYPES.ALL] = aggregate(metricsMap, meta, 'all');
        cacheByDays[d][MEASUREMENT_TYPES.CONV_TIME] = aggregate(metricsMap, meta, 'conv_time');
        cacheByDays[d][MEASUREMENT_TYPES.ALL_TIME] = aggregate(metricsMap, meta, 'all_time');
        console.log(`Ablak ${d} nap | ${range.label} – cache kész.`);
      }

      // Sorok kiértékelése
      for (const r of rows) {
        if (r.enabled === false) continue;

        // 1) Üres Napok → input hiba
        if (r.hasMissingDays) {
          const note = 'Hiba: a "Napok" mező üres a Beállítások fülön (töltsd ki 1–90 közötti számmal).';
          const status = 'ERROR';

          writeResultRow(resultsSheet, {
            timestamp: new Date(),
            accountId: formatId(id),
            customerName: r.name || acc.getName(),
            measurementType: r.measurementType,
            convName: r.convName,
            days: '',
            expConv: r.rawMinConv,
            actConv: '',
            expVal: r.rawMinVal,
            actVal: '',
            status: status,
            note: note
          });

          errorRows.push({
            Account: formatId(id),
            Customer: r.name || acc.getName(),
            MeasurementType: r.measurementType,
            Conv: r.convName,
            Days: '',
            ExpConv: r.rawMinConv,
            ActConv: '',
            ExpVal: r.rawMinVal,
            ActVal: '',
            Status: status,
            Note: note
          });

          continue;
        }

        // 2) Hibás Napok
        if (r.hasInvalidDays) {
          const note = `Hiba: érvénytelen "Napok" érték a Beállítások fülön (1–${MAX_LOOKBACK_DAYS} közötti számot adj meg).`;
          const status = 'ERROR';
          const rawDays = (r.rawDays === null || typeof r.rawDays === 'undefined') ? '' : String(r.rawDays);

          writeResultRow(resultsSheet, {
            timestamp: new Date(),
            accountId: formatId(id),
            customerName: r.name || acc.getName(),
            measurementType: r.measurementType,
            convName: r.convName,
            days: rawDays,
            expConv: r.rawMinConv,
            actConv: '',
            expVal: r.rawMinVal,
            actVal: '',
            status: status,
            note: note
          });

          errorRows.push({
            Account: formatId(id),
            Customer: r.name || acc.getName(),
            MeasurementType: r.measurementType,
            Conv: r.convName,
            Days: rawDays,
            ExpConv: r.rawMinConv,
            ActConv: '',
            ExpVal: r.rawMinVal,
            ActVal: '',
            Status: status,
            Note: note
          });

          continue;
        }

        // 3) Hibás küszöbök
        if (r.hasInvalidThresholds) {
          const note = 'Hiba: az "Elvárt konverziók" és/vagy "Elvárt konverziós érték" mező érvénytelen (nem-negatív számot adj meg).';
          const status = 'ERROR';

          writeResultRow(resultsSheet, {
            timestamp: new Date(),
            accountId: formatId(id),
            customerName: r.name || acc.getName(),
            measurementType: r.measurementType,
            convName: r.convName,
            days: r.days,
            expConv: r.rawMinConv,
            actConv: '',
            expVal: r.rawMinVal,
            actVal: '',
            status: status,
            note: note
          });

          errorRows.push({
            Account: formatId(id),
            Customer: r.name || acc.getName(),
            MeasurementType: r.measurementType,
            Conv: r.convName,
            Days: r.days,
            ExpConv: r.rawMinConv,
            ActConv: '',
            ExpVal: r.rawMinVal,
            ActVal: '',
            Status: status,
            Note: note
          });

          continue;
        }

        // --- ha idáig eljutunk, minden input OK, jöhet a normál logika ---

        const rangeNow = dateRange(r.days);
        const stats = (cacheByDays[r.days] || {})[r.measurementType] || { byName: {}, total: { conv: 0, value: 0 } };

        let conv = 0, val = 0;
        let status = 'OK';
        let note = `Ablak: ${rangeNow.label}`;
        let missingConversion = false;

        if (r.convName === ACCOUNT_TOTAL_KEYWORD) {
          conv = stats.total.conv;
          val = stats.total.value;
        } else {
          const entry = stats.byName[r.convName];
          if (entry) {
            conv = entry.conv;
            val = entry.value;
          } else {
            const existsEnabled = !!nameIndex.enabled[r.convName];
            if (existsEnabled) {
              conv = 0;
              val = 0;
              note += ' | Nincs konverzió az ellenőrzött ablakban.';
            } else {
              missingConversion = true;
              status = 'ERROR';
              note += ' | Hiba: a megadott konverzió nem található a fiókban (ellenőrizd a pontos nevet).';
              const availableNames = Object.keys(stats.byName);
              if (availableNames.length) {
                console.log(
                  `Hiányzó konverzió: "${r.convName}". Mintanév(ek): ` +
                  availableNames.slice(0, LOG_SAMPLE_LIMIT).join(', ') +
                  (availableNames.length > LOG_SAMPLE_LIMIT ? ' ...' : '')
                );
              }
            }
          }
        }

        if (!missingConversion) {
          status = compare(conv, val, r.minConv, r.minVal);
        }

        // Írás a sheetre – Időbélyeg az első oszlopban
        writeResultRow(resultsSheet, {
          timestamp: new Date(),
          accountId: formatId(id),
          customerName: r.name || acc.getName(),
          measurementType: r.measurementType,
          convName: r.convName,
          days: r.days,
          expConv: r.minConv,
          actConv: round2(conv),
          expVal: r.minVal,
          actVal: round2(val),
          status: status,
          note: note
        });

        // E-mail összefoglalóhoz
        const summaryRow = {
          Account: formatId(id),
          Customer: r.name || acc.getName(),
          MeasurementType: r.measurementType,
          Conv: r.convName,
          Days: r.days,
          ExpConv: r.minConv,
          ActConv: round2(conv),
          ExpVal: r.minVal,
          ActVal: round2(val),
          Status: status,
          Note: note
        };
        if (status === 'ERROR') errorRows.push(summaryRow);
        if (status !== 'OK' && status !== 'ERROR') deviationRows.push(summaryRow);
      }

    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      console.log(`Hiba ${formatId(id)}: ${msg}`);
      writeResultRow(resultsSheet, {
        timestamp: new Date(),
        accountId: formatId(id),
        customerName: acc.getName(),
        measurementType: 'Hiba',
        convName: '',
        days: '',
        expConv: '',
        actConv: '',
        expVal: '',
        actVal: '',
        status: 'ERROR',
        note: msg
      });
      errorRows.push({
        Account: formatId(id),
        Customer: acc.getName(),
        MeasurementType: 'Hiba',
        Conv: '',
        Days: '',
        ExpConv: '',
        ActConv: '',
        ExpVal: '',
        ActVal: '',
        Status: 'ERROR',
        Note: msg
      });
    }
  }

  // Nem elérhető fiókok – Beállítások szerinti sorrendben
  const missingIds = accountOrder.filter(id => !availableIdMap[id]);
  if (missingIds.length) {
    console.log(`Nem elérhető fiókok: ${missingIds.slice(0, LOG_SAMPLE_LIMIT).map(formatId).join(', ')}${missingIds.length > LOG_SAMPLE_LIMIT ? ' ...' : ''}`);
    for (const mid of missingIds) {
      const rows = grouped[mid] || [{}];
      const prettyId = formatId(mid);
      const customerName = (rows[0] && rows[0].name) ? rows[0].name : '';
      const note = 'A fiók nem található vagy nincs hozzáférés (ellenőrizd az azonosítót és a jogosultságot).';
      writeResultRow(resultsSheet, {
        timestamp: new Date(),
        accountId: prettyId,
        customerName: customerName,
        measurementType: 'Hiba',
        convName: '',
        days: '',
        expConv: '',
        actConv: '',
        expVal: '',
        actVal: '',
        status: 'ERROR',
        note: note
      });
      errorRows.push({
        Account: prettyId,
        Customer: customerName,
        MeasurementType: 'Hiba',
        Conv: '',
        Days: '',
        ExpConv: '',
        ActConv: '',
        ExpVal: '',
        ActVal: '',
        Status: 'ERROR',
        Note: note
      });
    }
  }

  // Trend riport + chartok (opcionális)
  let trendUpdated = false;
  if (ENABLE_TREND_REPORT) {
    try {
      generateTrendReport(grouped, accountOrder, accountMap);
      trendUpdated = true;
    } catch (e) {
      console.log(`Trend riport hiba: ${String(e && e.message ? e.message : e)}`);
      // Nem állítjuk meg a teljes scriptet; a monitoring rész maradjon meg.
    }
  }

  // E-mail értesítő – mindig küldünk
  writeStatusEmail(deviationRows, errorRows, (deviationRows.length === 0 && errorRows.length === 0), trendUpdated);

  console.log('--- Kész ---');
}

// =======================
// ===== GAQL QUERYK =====
// =======================

/**
 * Konverzió metaadatok: resource_name + name + status.
 */
function buildConversionMetaQuery() {
  return `SELECT
            conversion_action.resource_name,
            conversion_action.name,
            conversion_action.status
          FROM conversion_action`;
}

/**
 * Összesített metrikák a vizsgált ablakra.
 */
function buildMetricsQuery(start, end) {
  return `SELECT
            segments.conversion_action,
            metrics.conversions,
            metrics.conversions_value,
            metrics.all_conversions,
            metrics.all_conversions_value,
            metrics.conversions_by_conversion_date,
            metrics.conversions_value_by_conversion_date,
            metrics.all_conversions_by_conversion_date,
            metrics.all_conversions_value_by_conversion_date
          FROM customer
          WHERE segments.date BETWEEN '${start}' AND '${end}'`;
}

/**
 * Napi bontású metrikák a trend riporthoz.
 */
function buildDailyMetricsQuery(start, end) {
  return `SELECT
            segments.date,
            segments.conversion_action,
            metrics.conversions,
            metrics.conversions_value,
            metrics.all_conversions,
            metrics.all_conversions_value,
            metrics.conversions_by_conversion_date,
            metrics.conversions_value_by_conversion_date,
            metrics.all_conversions_by_conversion_date,
            metrics.all_conversions_value_by_conversion_date
          FROM customer
          WHERE segments.date BETWEEN '${start}' AND '${end}'`;
}

// =======================
// ===== LEKÉRDEZÉS =====
// =======================

/**
 * GAQL report lekérdezés RATE_EXCEEDED védelemmel.
 */
function reportWithRetry(query, maxRetries) {
  const retries = (typeof maxRetries === 'number') ? maxRetries : 3;
  for (let i = 0; i < retries; i++) {
    try {
      return AdsApp.report(query);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const isRate = msg.indexOf('RATE_EXCEEDED') !== -1 || msg.indexOf('Rate exceeded') !== -1;
      if (isRate && i < retries - 1) {
        const delayMs = Math.pow(2, i) * 1000; // 0s, 1s, 2s, 4s...
        console.log(`Rate limit – újrapróbálkozás ${delayMs}ms múlva... (${i + 1}/${retries})`);
        Utilities.sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Riportsorok beolvasása map-be, kulcs: segments.conversion_action.
 * Érték: összesített metrikák.
 */
function fetchMetrics(q) {
  const rep = reportWithRetry(q);
  const it = rep.rows();
  const m = {};
  while (it.hasNext()) {
    const r = it.next();
    const k = String(r['segments.conversion_action'] || '').trim();
    if (!k) continue;
    const obj = (m[k] || (m[k] = {
      conv: 0, value: 0,
      allConv: 0, allValue: 0,
      convByTime: 0, valByTime: 0,
      allByTime: 0, allValByTime: 0
    }));
    obj.conv += toNum(r['metrics.conversions'], 0);
    obj.value += toNum(r['metrics.conversions_value'], 0);
    obj.allConv += toNum(r['metrics.all_conversions'], 0);
    obj.allValue += toNum(r['metrics.all_conversions_value'], 0);
    obj.convByTime += toNum(r['metrics.conversions_by_conversion_date'], 0);
    obj.valByTime += toNum(r['metrics.conversions_value_by_conversion_date'], 0);
    obj.allByTime += toNum(r['metrics.all_conversions_by_conversion_date'], 0);
    obj.allValByTime += toNum(r['metrics.all_conversions_value_by_conversion_date'], 0);
  }
  return m;
}

/**
 * Napi bontású metrikák beolvasása:
 * daily[dateStr][conversionActionResource] = metricsObj
 */
function fetchDailyMetrics(q) {
  const rep = reportWithRetry(q);
  const it = rep.rows();
  const daily = {}; // { 'yyyy-MM-dd': { 'customers/.../conversionActions/...': metricsObj } }

  let logged = 0;

  while (it.hasNext()) {
    const r = it.next();
    const dateStr = String(r['segments.date'] || '').trim();
    const actionRes = String(r['segments.conversion_action'] || '').trim();
    if (!dateStr || !actionRes) continue;

    const dayBucket = (daily[dateStr] || (daily[dateStr] = {}));
    const obj = (dayBucket[actionRes] || (dayBucket[actionRes] = {
      conv: 0, value: 0,
      allConv: 0, allValue: 0,
      convByTime: 0, valByTime: 0,
      allByTime: 0, allValByTime: 0
    }));

    obj.conv += toNum(r['metrics.conversions'], 0);
    obj.value += toNum(r['metrics.conversions_value'], 0);
    obj.allConv += toNum(r['metrics.all_conversions'], 0);
    obj.allValue += toNum(r['metrics.all_conversions_value'], 0);
    obj.convByTime += toNum(r['metrics.conversions_by_conversion_date'], 0);
    obj.valByTime += toNum(r['metrics.conversions_value_by_conversion_date'], 0);
    obj.allByTime += toNum(r['metrics.all_conversions_by_conversion_date'], 0);
    obj.allValByTime += toNum(r['metrics.all_conversions_value_by_conversion_date'], 0);

    if (logged < LOG_SAMPLE_LIMIT) {
      console.log(`Trend row sample: ${dateStr} | ${actionRes} | conv=${round2(obj.conv)}`);
      logged++;
    }
  }
  return daily;
}

/**
 * Konverzió metaadatok lekérése (név, státusz).
 */
function fetchConversionMeta(q) {
  const report = reportWithRetry(q);
  const it = report.rows();
  const meta = {};
  while (it.hasNext()) {
    const r = it.next();
    const resName = String(r['conversion_action.resource_name']);
    meta[resName] = {
      name: String(r['conversion_action.name']),
      status: String(r['conversion_action.status'])
    };
  }
  return meta;
}

/**
 * Név-alapú index a meta-hoz (csak ENABLED konverziók).
 */
function buildNameIndex(meta) {
  const enabled = {};
  for (const res in meta) {
    if (!Object.prototype.hasOwnProperty.call(meta, res)) continue;
    const m = meta[res];
    if (m.status === 'ENABLED') {
      const n = m.name || '(névtelen)';
      enabled[n] = true;
    }
  }
  return { enabled: enabled };
}

// =======================
// ===== AGGREGÁLÁS =====
// =======================

/**
 * Aggregálás: csak ENABLED conversion_action-öket számolunk bele.
 */
function aggregate(metrics, meta, metricKey) {
  const by = {};
  const tot = { conv: 0, value: 0 };

  for (const k in metrics) {
    const s = metrics[k];
    const x = meta[k];
    if (!x) continue;
    if (x.status !== 'ENABLED') continue;

    let useConv = 0, useValue = 0;
    if (metricKey === 'conv') {
      useConv = s.conv; useValue = s.value;
    } else if (metricKey === 'all') {
      useConv = s.allConv; useValue = s.allValue;
    } else if (metricKey === 'conv_time') {
      useConv = s.convByTime; useValue = s.valByTime;
    } else if (metricKey === 'all_time') {
      useConv = s.allByTime; useValue = s.allValByTime;
    }

    const n = x.name || '(névtelen)';
    if (!by[n]) by[n] = { conv: 0, value: 0 };
    by[n].conv += useConv;
    by[n].value += useValue;

    tot.conv += useConv;
    tot.value += useValue;
  }

  return { byName: by, total: tot };
}

// =======================
// ===== SHEET ÍRÁS =====
// =======================

function writeResultsHeader(sh) {
  sh.clearContents();
  const head = [
    'Időbélyeg',
    'Fiók', 'Ügyfél', 'Konverziómérés típusa', 'Konverziós művelet',
    'Napok', 'Elvárt db', 'Tényleges db', 'Elvárt érték', 'Tényleges érték',
    'Státusz', 'Megjegyzés'
  ];
  sh.getRange(1, 1, 1, head.length).setValues([head]);
}

function writeResultRow(sh, o) {
  const row = [
    o.timestamp || new Date(),
    o.accountId,
    o.customerName,
    o.measurementType,
    o.convName,
    o.days,
    o.expConv,
    o.actConv,
    o.expVal,
    o.actVal,
    o.status,
    o.note
  ];
  sh.appendRow(row);

  // --- Fiókonként váltakozó háttérszín ---
  const lastRow = sh.getLastRow();

  if (o.accountId !== lastShadingAccountId) {
    lastShadingIsGrey = !lastShadingIsGrey;
    lastShadingAccountId = o.accountId;
  }

  const color = lastShadingIsGrey ? '#f3f3f3' : '#ffffff';
  const range = sh.getRange(lastRow, 1, 1, row.length);
  range.setBackground(color);
}

function emailBodyTable(rows, link, leadText) {
  let html = '';
  if (leadText) html += `<p>${esc(leadText)}</p>`;
  html += `<p><a href="${link}" target="_blank">Megnyitás a Google Sheetben</a></p>`;
  if (rows.length) {
    html += '<table border=1 cellpadding=4 cellspacing=0>';
    html += '<tr>' +
      '<th>Fiók</th>' +
      '<th>Ügyfél</th>' +
      '<th>Konverziómérés típusa</th>' +
      '<th>Konverziós művelet</th>' +
      '<th>Napok</th>' +
      '<th>Elvárt db</th>' +
      '<th>Tényleges db</th>' +
      '<th>Elvárt érték</th>' +
      '<th>Tényleges érték</th>' +
      '<th>Státusz</th>' +
      '<th>Megjegyzés</th>' +
      '</tr>';

    let prevAccount = null;
    let useGrey = false;

    for (const r of rows) {
      if (r.Account !== prevAccount) {
        useGrey = !useGrey;
        prevAccount = r.Account;
      }
      const bg = useGrey ? '#f3f3f3' : '#ffffff';

      html += `<tr style="background-color:${bg}">` +
        `<td>${esc(r.Account)}</td>` +
        `<td>${esc(r.Customer)}</td>` +
        `<td>${esc(r.MeasurementType)}</td>` +
        `<td>${esc(r.Conv)}</td>` +
        `<td>${esc(r.Days)}</td>` +
        `<td>${esc(r.ExpConv)}</td>` +
        `<td>${esc(r.ActConv)}</td>` +
        `<td>${esc(r.ExpVal)}</td>` +
        `<td>${esc(r.ActVal)}</td>` +
        `<td>${esc(r.Status)}</td>` +
        `<td>${esc(r.Note)}</td>` +
        `</tr>`;
    }

    html += '</table>';
  }
  return html;
}

// =======================
// ====== SEGÉDEK ========
// =======================

function getSheets() {
  const ss = SpreadsheetApp.openByUrl(SHEET_URL);
  const set = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!set) throw 'Hiányzik a Beállítások fül.';
  let res = ss.getSheetByName(RESULTS_SHEET_NAME);
  if (!res) res = ss.insertSheet(RESULTS_SHEET_NAME);
  return { settingsSheet: set, resultsSheet: res };
}

function readConfig(sh) {
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];

  const h = vals[0].map(x => String(x).trim());
  const idx = {
    id: h.indexOf('Fiókazonosító'),
    name: h.indexOf('Ügyfélnév'),
    meas: h.indexOf('Konverziómérés típusa'),
    conv: h.indexOf('Konverziós művelet'),
    days: h.indexOf('Napok'),
    minC: h.indexOf('Elvárt konverziók'),
    minV: h.indexOf('Elvárt konverziós érték'),
    en: h.indexOf('Engedélyezve')
  };

  // Kötelező oszlopok ellenőrzése
  EXPECTED_HEADERS.forEach(function (header) {
    if (h.indexOf(header) === -1) {
      throw new Error(`Hiányzó oszlop a Beállítások fülön: "${header}". Ellenőrizd, hogy az első sorban pontosan így szerepel!`);
    }
  });

  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!r[idx.id]) continue;

    const measurementType = normalizeMeasurementType(String(r[idx.meas] || '').trim());
    if (!measurementType) {
      console.log(`Figyelem: Ismeretlen "Konverziómérés típusa" a(z) ${i + 1}. sorban – kihagyva.`);
      continue;
    }

    const rawDays = r[idx.days];
    const rawMinConv = r[idx.minC];
    const rawMinVal = r[idx.minV];

    const daysCheck = validateDays(rawDays);
    const convField = parseNonNegativeNumberField(rawMinConv);
    const valField = parseNonNegativeNumberField(rawMinVal);

    out.push({
      id: normalizeId(r[idx.id]),
      name: r[idx.name] || '',
      measurementType: measurementType,
      convName: String(r[idx.conv]).trim(),

      days: daysCheck.days,

      minConv: convField.value,
      minVal: valField.value,

      enabled: parseYesNo(r[idx.en], true),

      hasMissingDays: daysCheck.hasMissing,
      hasInvalidDays: daysCheck.hasInvalid,
      hasInvalidThresholds: convField.invalid || valField.invalid,

      rawDays: rawDays,
      rawMinConv: rawMinConv,
      rawMinVal: rawMinVal
    });
  }

  return out;
}

function normalizeMeasurementType(s) {
  const choices = [
    MEASUREMENT_TYPES.CONV,
    MEASUREMENT_TYPES.ALL,
    MEASUREMENT_TYPES.CONV_TIME,
    MEASUREMENT_TYPES.ALL_TIME
  ];
  for (let i = 0; i < choices.length; i++) {
    if (s === choices[i]) return choices[i];
  }
  return '';
}

/**
 * Napok mező validálása:
 * - Üres → hasMissing=true, days=7 (placeholder)
 * - 0 → days=7 (OK)
 * - Negatív, túl nagy, szöveg → hasInvalid=true
 */
function validateDays(rawValue) {
  const result = { days: 7, hasMissing: false, hasInvalid: false };

  if (rawValue === null || rawValue === '' || typeof rawValue === 'undefined') {
    result.hasMissing = true;
    return result;
  }

  const raw = String(rawValue).trim();

  if (raw === '0') {
    result.days = 7;
    return result;
  }

  const n = toInt(raw, NaN);
  if (isNaN(n) || n < 1 || n > MAX_LOOKBACK_DAYS) {
    result.hasInvalid = true;
    return result;
  }

  result.days = n;
  return result;
}

/**
 * Elvárt konverziók / Elvárt konverziós érték mezők validálása:
 * - Üres → 0, invalid=false
 * - Negatív vagy nem szám → invalid=true
 */
function parseNonNegativeNumberField(rawValue) {
  const result = { value: 0, invalid: false };

  if (rawValue === null || rawValue === '') return result;

  const n = toNum(rawValue, NaN);
  if (isNaN(n) || n < 0) {
    result.invalid = true;
    return result;
  }

  result.value = n;
  return result;
}

function groupByAccount(a) {
  const m = {};
  for (const r of a) { if (!m[r.id]) m[r.id] = []; m[r.id].push(r); }
  return m;
}

function uniqueDays(a) {
  const s = {};
  for (const r of a) s[r.days] = 1;
  return Object.keys(s).map(Number);
}

/**
 * Időzóna-biztos dátumablak:
 * - meghatározzuk a fiók időzónájában a "ma" naptári napot (yyyy-MM-dd)
 * - létrehozunk egy 00:00 UTC dátumot ehhez a naphoz
 * - az aritmetikát UTC-ben végezzük (ms kivonással), így nincs +/- 1 nap csúszás
 * - a visszaadott start/end yyyy-MM-dd a GAQL BETWEEN-hez
 */
function dateRange(days) {
  const tz = AdsApp.currentAccount().getTimeZone();

  // 1) "Ma" naptári nap a fiók időzónájában
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const parts = todayStr.split('-');
  const year = Number(parts[0]);
  const monthZeroBased = Number(parts[1]) - 1;
  const day = Number(parts[2]);

  // 2) "Ma 00:00" UTC
  const todayUTC = new Date(Date.UTC(year, monthZeroBased, day));

  // 3) Tegnap 00:00 UTC (időszak vége)
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const endUTC = new Date(todayUTC.getTime() - ONE_DAY_MS);

  // 4) Kezdőnap 00:00 UTC
  const startUTC = new Date(endUTC.getTime() - (days - 1) * ONE_DAY_MS);

  // 5) Vissza stringgé
  const start = Utilities.formatDate(startUTC, 'UTC', 'yyyy-MM-dd');
  const end = Utilities.formatDate(endUTC, 'UTC', 'yyyy-MM-dd');
  const label = Utilities.formatDate(startUTC, 'UTC', 'yyyy.MM.dd.') + ' → ' +
    Utilities.formatDate(endUTC, 'UTC', 'yyyy.MM.dd.');

  return { start: start, end: end, label: label };
}

function compare(c, v, mc, mv) {
  const bc = c < (mc || 0), bv = v < (mv || 0);
  if (!bc && !bv) return 'OK';
  if (bc && bv) return 'BELOW_BOTH';
  if (bc) return 'BELOW_CONVERSIONS';
  return 'BELOW_VALUE';
}

function normalizeId(x) { return String(x).replace(/[^0-9]/g, ''); }
function formatId(x) { const s = normalizeId(x); return `${s.substr(0, 3)}-${s.substr(3, 3)}-${s.substr(6)}`; }
function toNum(v, d) { if (v === '' || v == null) return d; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? d : n; }
function toInt(v, d) { if (v === '' || v == null) return d; const n = parseInt(v, 10); return isNaN(n) ? d : n; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function esc(s) {
  const str = (s === null || s === undefined) ? '' : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseYesNo(v, def) {
  if (v == null || v === '') return def;
  const x = String(v).trim().toLowerCase();
  if (['igen', 'true', 't', '1', 'yes', 'y'].includes(x)) return true;
  if (['nem', 'false', 'f', '0', 'no', 'n'].includes(x)) return false;
  return def;
}

function validateConfig() {
  if (!SHEET_URL || !SHEET_URL.startsWith('http')) throw 'Hiányzó SHEET_URL';
}

// =======================
// ====== E-MAIL ========
// =======================

/**
 * E-mail logika a kért tárgyakkal + trend státusz sor.
 */
function writeStatusEmail(deviations, errors, everythingOk, trendUpdated) {
  if (!EMAIL_RECIPIENTS) {
    console.log('Nincs címzett beállítva, e-mail kihagyva.');
    return;
  }

  let subject = '';
  let body = '';

  // Limit e-mailben megjelenített sorok számát
  let deviationsOut = deviations;
  let errorsOut = errors;
  if (deviationsOut.length > MAX_ROWS_IN_EMAIL) {
    console.log(`Eltérések száma ${deviationsOut.length} → e-mailben csak az első ${MAX_ROWS_IN_EMAIL}.`);
    deviationsOut = deviationsOut.slice(0, MAX_ROWS_IN_EMAIL);
  }
  if (errorsOut.length > MAX_ROWS_IN_EMAIL) {
    console.log(`Hibák száma ${errorsOut.length} → e-mailben csak az első ${MAX_ROWS_IN_EMAIL}.`);
    errorsOut = errorsOut.slice(0, MAX_ROWS_IN_EMAIL);
  }

  if (everythingOk) {
    subject = 'Konverziómérés figyelő - Minden szuper!';
    body = emailBodyTable([], SHEET_URL,
      'Csak így tovább! :-) Rendben vannak a konverziószámok és konverziós értékek a fiókjaidban.');
    if (trendUpdated) {
      body += `<p><b>Trend riport frissítve:</b> Last ${TREND_DAYS} days (daily), fiókonként külön fülön.</p>`;
    }
  } else {
    const haveDev = deviations.length > 0;
    const haveErr = errors.length > 0;
    if (haveDev && haveErr) {
      subject = 'Konverziómérés figyelő - eltérések és hibák';
    } else if (haveDev) {
      subject = 'Konverziómérés figyelő - eltérések';
    } else {
      subject = 'Konverziómérés figyelő - hibák';
    }
    if (haveErr) {
      body += '<h3>Hibák</h3>';
      body += emailBodyTable(errorsOut, SHEET_URL, '');
    }
    if (haveDev) {
      body += '<h3>Eltérések</h3>';
      body += emailBodyTable(deviationsOut, SHEET_URL, '');
    }
    if (trendUpdated) {
      body += `<p><b>Trend riport frissítve:</b> Last ${TREND_DAYS} days (daily), fiókonként külön fülön.</p>`;
    }
  }

  MailApp.sendEmail({ to: EMAIL_RECIPIENTS, subject: subject, htmlBody: body });
  console.log(`Értesítő elküldve → ${EMAIL_RECIPIENTS} | Tárgy: ${subject}`);
}

// =======================
// ===== TREND RIPORT =====
// =======================

/**
 * Trend riport generálása: fiókonként külön fül, azon belül blokkok egymás alatt.
 * Blokkonként: cím + minimumok + táblázat + 1 chart (2 vonal: conversions + value).
 */
function generateTrendReport(groupedByAccount, accountOrder, accountMap) {
  console.log('--- Trend riport indul ---');

  const ss = SpreadsheetApp.openByUrl(SHEET_URL);

  // Trend ablak: fixen TREND_DAYS, tegnapig
  // (AdsManagerApp.select(acc) alatt a dateRange() a fiók timeZone szerint adja ki a "ma" napját.)
  for (const id of accountOrder) {
    const acc = accountMap[id];
    if (!acc) continue;

    const rules = (groupedByAccount[id] || []).filter(r => r.enabled !== false);
    if (!rules.length) continue;

    AdsManagerApp.select(acc);

    const trendRange = dateRange(TREND_DAYS);

    // -- Módosítás: Fiók név használata ID helyett a fül nevében
    // Sheet név limit: 100 karakter, tiltott: * : / \ ? [ ]
    let safeName = acc.getName().replace(/[\*:\/\\\?\[\]]/g, ' ').trim();
    // Prefix + safeName hossza max 100 legyen
    // Prefix hossza: TREND_SHEET_PREFIX.length
    const maxLength = 100 - TREND_SHEET_PREFIX.length;
    if (safeName.length > maxLength) {
      safeName = safeName.substring(0, maxLength);
    }
    const sheetName = `${TREND_SHEET_PREFIX}${safeName}`;

    let sh = ss.getSheetByName(sheetName);
    if (!sh) sh = ss.insertSheet(sheetName);

    if (CLEAR_TREND_TABS_ON_RUN) {
      sh.clearContents();
      const charts = sh.getCharts();
      for (let i = 0; i < charts.length; i++) {
        sh.removeChart(charts[i]);
      }
    }

    console.log(`Trend fül: ${sheetName} | Szabályok: ${rules.length} | Ablak: ${trendRange.label}`);

    // Meta + indexek (ENABLED only)
    const meta = fetchConversionMeta(buildConversionMetaQuery());
    const enabledResourcesByName = buildEnabledResourcesByName(meta);
    const enabledResourcesAll = Object.keys(meta).filter(res => meta[res] && meta[res].status === 'ENABLED');

    // Napi metrikák lekérése egyszer
    const daily = fetchDailyMetrics(buildDailyMetricsQuery(trendRange.start, trendRange.end));

    // Dátumlista (TREND_DAYS elem) a trendRange alapján
    const dateList = buildDateList(trendRange.start, TREND_DAYS);

    // Fejléc
    sh.getRange(1, 1).setValue(`Account: ${acc.getName()} (${formatId(id)})`);
    sh.getRange(2, 1).setValue(`Last ${TREND_DAYS} days (daily) | ${trendRange.label}`);

    let cursorRow = 4;

    for (const r of rules) {
      const blockTitle = `${r.convName} - ${r.measurementType}`;
      const resources = resolveResourcesForRule(r, enabledResourcesByName, enabledResourcesAll);

      const series = buildDailySeries(dateList, daily, resources, r.measurementType);

      const minConv = series.minConv;
      const minVal = series.minVal;

      // Gap analízis, ha alacsony volumenű konverzió (min = 0)
      let gapAnalysis = null;
      if (minConv === 0) {
        const convValues = series.rows.map(function (row) { return row[1]; }); // Konverziók oszlop
        const valueValues = series.rows.map(function (row) { return row[2]; }); // Értékek oszlop
        gapAnalysis = analyzeConversionGaps(convValues, valueValues);
      }

      // Cím + minimumok
      sh.getRange(cursorRow, 1).setValue(blockTitle);
      sh.getRange(cursorRow + 1, 1).setValue(`Last ${TREND_DAYS} days`);
      sh.getRange(cursorRow + 2, 1).setValue(`Min conversions: ${round2(minConv)}`);
      sh.getRange(cursorRow + 3, 1).setValue(`Min conversion value: ${round2(minVal)}`);

      // Ha van gap analízis, javaslatok megjelenítése
      let nextRow = cursorRow + 4;
      if (gapAnalysis && gapAnalysis.conservativeRecommendation) {
        sh.getRange(nextRow, 1).setValue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        nextRow++;
        sh.getRange(nextRow, 1).setValue('📊 Javaslatok alacsony volumen esetén (másolható értékek):');
        nextRow++;

        // Táblázat fejléc
        sh.getRange(nextRow, 1, 1, 4).setValues([['Javaslat típus', 'Napok', 'Min konv', 'Min érték']]);
        sh.getRange(nextRow, 1, 1, 4).setFontWeight('bold');
        nextRow++;

        // Konzervatív sor - parse-oljuk a recommendation string-et
        const consValues = parseRecommendation(gapAnalysis.conservativeRecommendation);
        sh.getRange(nextRow, 1).setValue('Konzervatív (max gap + 1)');
        sh.getRange(nextRow, 2).setValue(consValues.days);
        sh.getRange(nextRow, 3).setValue(consValues.conv);
        sh.getRange(nextRow, 4).setValue(consValues.value || '-');
        nextRow++;

        // Ajánlott sor (ha van elég adat)
        if (gapAnalysis.recommendedRecommendation) {
          const recValues = parseRecommendation(gapAnalysis.recommendedRecommendation);
          sh.getRange(nextRow, 1).setValue('Érzékenyebb (medián + 1)');
          sh.getRange(nextRow, 2).setValue(recValues.days);
          sh.getRange(nextRow, 3).setValue(recValues.conv);
          sh.getRange(nextRow, 4).setValue(recValues.value || '-');
          nextRow++;
        }

        // Magyarázat a számítási módszerről
        nextRow++;
        sh.getRange(nextRow, 1).setValue('💡 Számítás: minden lehetséges N napos ablak konverziószámának minimuma (worst-case védelem).');
        sh.getRange(nextRow, 1).setFontStyle('italic');
        sh.getRange(nextRow, 1).setFontColor('#666666');
        nextRow++;
      }

      // Táblázat
      const tableStartRow = nextRow + 1;
      sh.getRange(tableStartRow, 1, 1, 3).setValues([['Date', 'Conversions', 'Conversion value']]);

      const values = series.rows; // [[date, conv, value], ...]
      if (values.length) {
        sh.getRange(tableStartRow + 1, 1, values.length, 3).setValues(values);
      }

      // Chart (1 chart, 2 vonal)
      const tableRange = sh.getRange(tableStartRow, 1, (values.length + 1), 3);
      const chartRow = tableStartRow;
      const chartCol = 5;

      const chart = sh.newChart()
        .asLineChart()
        .addRange(tableRange)
        .setPosition(chartRow, chartCol, 0, 0)
        .setOption('title', blockTitle)
        .setOption('legend', { position: 'bottom' })
        .setOption('curveType', 'none')
        .setOption('hAxis', { title: 'Date' })
        // --- Dupla Y tengely beállítása ---
        .setOption('series', {
          0: { targetAxisIndex: 0, labelInLegend: 'Conversions' },      // Bal tengely
          1: { targetAxisIndex: 1, labelInLegend: 'Conversion Value' }   // Jobb tengely
        })
        .setOption('vAxes', {
          0: { title: 'Conversions' },
          1: { title: 'Value' }
        })
        .build();

      sh.insertChart(chart);

      // Következő blokk: helyet hagyunk
      cursorRow = tableStartRow + values.length + 6;
    }
  }

  console.log('--- Trend riport kész ---');
}

/**
 * ENABLED konverziók erőforrásainak indexe név szerint.
 * Ha duplikált a név (több ENABLED conversion_action ugyanazzal a névvel), mindet eltároljuk.
 */
function buildEnabledResourcesByName(meta) {
  const map = {}; // { name: [resource1, resource2] }
  for (const res in meta) {
    if (!Object.prototype.hasOwnProperty.call(meta, res)) continue;
    const m = meta[res];
    if (!m || m.status !== 'ENABLED') continue;
    const name = m.name || '(névtelen)';
    if (!map[name]) map[name] = [];
    map[name].push(res);
  }
  return map;
}

/**
 * Parse recommendation string to extract values for table display.
 * Input: "Napok=14, Min konv=2, Min érték=150"
 * Output: { days: 14, conv: 2, value: 150 }
 */
function parseRecommendation(recString) {
  const result = { days: null, conv: null, value: null };

  // Extract Napok
  const daysMatch = recString.match(/Napok=(\d+)/);
  if (daysMatch) result.days = parseInt(daysMatch[1], 10);

  // Extract Min konv
  const convMatch = recString.match(/Min konv=(\d+)/);
  if (convMatch) result.conv = parseInt(convMatch[1], 10);

  // Extract Min érték (robusztus: kezeli szóközt, vesszőt, pontot)
  const valueMatch = recString.match(/Min érték=([\d\s.,]+)/);
  if (valueMatch) {
    // Tisztítás: eltávolítjuk a szóközöket, vesszőt pontra cseréljük
    const cleaned = valueMatch[1].replace(/\s/g, '').replace(',', '.');
    result.value = parseFloat(cleaned);
  }

  return result;
}

/**
 * Szabályhoz tartozó resource-ok feloldása:
 * - TELJES FIÓK: minden ENABLED resource
 * - név: az adott névhez tartozó ENABLED resource-ok
 */
function resolveResourcesForRule(rule, enabledResourcesByName, enabledResourcesAll) {
  if (rule.convName === ACCOUNT_TOTAL_KEYWORD) {
    return enabledResourcesAll;
  }
  return enabledResourcesByName[rule.convName] || [];
}

/**
 * Csúszó ablak (sliding window) minimuma - O(n) optimalizált verzió.
 * Kiszámítja az összes N napos ablak konverziószámát, és visszaadja a minimumot.
 * @param {Array} values - Napi értékek tömbje
 * @param {number} windowSize - Ablak mérete (napok)
 * @returns {number} Minimum összeg az összes ablakból
 */
function calculateSlidingWindowMin(values, windowSize) {
  if (windowSize > values.length) return 0;
  if (windowSize <= 0) return 0;

  // Első ablak összege
  let currentSum = 0;
  for (let i = 0; i < windowSize; i++) {
    currentSum += values[i];
  }
  let minSum = currentSum;

  // Rolling sum: kiveszünk egyet balról, hozzáadunk egyet jobbról
  for (let i = windowSize; i < values.length; i++) {
    currentSum = currentSum - values[i - windowSize] + values[i];
    if (currentSum < minSum) {
      minSum = currentSum;
    }
  }

  return minSum;
}

/**
 * Gap analízis alacsony volumenű konverziókhoz.
 * Kiszámítja a leghosszabb és a medián gap-et (egymás utáni nullás napok száma).
 * Valamint átlagos konverziós értéket javasol.
 * @param {Array} conversionValues - Napi konverziószámok tömbje (számok)
 * @param {Array} valueData - Napi konverziós értékek tömbje (számok)
 * @returns {Object} { maxGap, medianGap, avgValue, conservativeRecommendation, recommendedRecommendation }
 */
function analyzeConversionGaps(conversionValues, valueData) {
  const gaps = [];
  let currentGap = 0;

  // Értékek és konverziók összegyűjtése (csak ahol > 0 konverzió volt)
  let totalConversions = 0;
  let totalValue = 0;

  for (let i = 0; i < conversionValues.length; i++) {
    if (conversionValues[i] === 0) {
      currentGap++;
    } else {
      if (currentGap > 0) {
        gaps.push(currentGap);
        currentGap = 0;
      }
      // Konverziók és értékek összegzése (0 érték is számít!)
      totalConversions += conversionValues[i];
      if (valueData) {
        totalValue += (valueData[i] || 0);
      }
    }
  }
  // Ha az utolsó szakasz is 0-ás volt
  if (currentGap > 0) {
    gaps.push(currentGap);
  }

  // Átlagos érték per konverzió számítása
  let avgValuePerConversion = 0;
  if (totalConversions > 0 && totalValue > 0) {
    avgValuePerConversion = totalValue / totalConversions;
  }

  // Ha nincs gap (soha nem volt 0 konverzió), nincs javaslat szükséges
  if (gaps.length === 0) {
    return {
      maxGap: 0,
      medianGap: 0,
      avgValue: avgValuePerConversion,
      conservativeRecommendation: null,
      recommendedRecommendation: null
    };
  }

  // Maximum gap
  const maxGap = Math.max.apply(null, gaps);

  // Medián gap (50. percentilis) - csak ha van elég adat
  let medianGap = null;
  let hasEnoughData = gaps.length >= 3;

  if (hasEnoughData) {
    const sortedGaps = gaps.slice().sort(function (a, b) { return a - b; });
    const midIndex = Math.floor(sortedGaps.length / 2);
    if (sortedGaps.length % 2 === 0) {
      // Páros számú elem esetén a középső kettő átlaga
      medianGap = Math.round((sortedGaps[midIndex - 1] + sortedGaps[midIndex]) / 2);
    } else {
      // Páratlan számú elem esetén a középső
      medianGap = sortedGaps[midIndex];
    }
  }

  // Javaslatok: gap + 1 nap
  const conservativeDays = maxGap + 1;

  // Csúszó ablak minimum: minden N napos ablak közül a legkisebb konverziószám
  const conservativeMinConv = Math.max(1, Math.ceil(calculateSlidingWindowMin(conversionValues, conservativeDays)));

  // Érték javaslat: átlag érték per konverzió × várható konverziók
  let conservativeValue = '';
  if (avgValuePerConversion > 0) {
    conservativeValue = `, Min érték=${round2(avgValuePerConversion * conservativeMinConv)}`;
  }

  const result = {
    maxGap: maxGap,
    medianGap: medianGap || 0,
    avgValue: avgValuePerConversion,
    conservativeRecommendation: `Napok=${conservativeDays}, Min konv=${conservativeMinConv}${conservativeValue}`,
    recommendedRecommendation: null
  };

  // Csak akkor adjunk ajánlott javaslatot, ha van elég adat
  if (hasEnoughData && medianGap !== null) {
    const recommendedDays = medianGap + 1;
    const recommendedMinConv = Math.max(1, Math.ceil(calculateSlidingWindowMin(conversionValues, recommendedDays)));
    let recommendedValue = '';
    if (avgValuePerConversion > 0) {
      recommendedValue = `, Min érték=${round2(avgValuePerConversion * recommendedMinConv)}`;
    }
    result.recommendedRecommendation = `Napok=${recommendedDays}, Min konv=${recommendedMinConv}${recommendedValue}`;
  }

  return result;
}

/**
 * Napi sorozat felépítése dátumlistából + daily mapből + resource listából, measurementType alapján.
 * Visszaad: { rows, minConv, minVal }
 */
function buildDailySeries(dateList, daily, resources, measurementType) {
  let minConv = null;
  let minVal = null;

  const rows = [];

  for (const dateStr of dateList) {
    let convSum = 0;
    let valSum = 0;

    const bucket = daily[dateStr] || {};

    for (const res of resources) {
      const m = bucket[res];
      if (!m) continue;

      const pair = pickMetricPair(m, measurementType);
      convSum += pair.conv;
      valSum += pair.value;
    }

    if (minConv === null || convSum < minConv) minConv = convSum;
    if (minVal === null || valSum < minVal) minVal = valSum;

    rows.push([dateStr, round2(convSum), round2(valSum)]);
  }

  if (minConv === null) minConv = 0;
  if (minVal === null) minVal = 0;

  return { rows: rows, minConv: minConv, minVal: minVal };
}

/**
 * MeasurementType alapján kiválasztja a megfelelő metrikapárt.
 */
function pickMetricPair(m, measurementType) {
  if (measurementType === MEASUREMENT_TYPES.CONV) {
    return { conv: m.conv, value: m.value };
  }
  if (measurementType === MEASUREMENT_TYPES.ALL) {
    return { conv: m.allConv, value: m.allValue };
  }
  if (measurementType === MEASUREMENT_TYPES.CONV_TIME) {
    return { conv: m.convByTime, value: m.valByTime };
  }
  return { conv: m.allByTime, value: m.allValByTime }; // MEASUREMENT_TYPES.ALL_TIME
}

/**
 * Dátumlista létrehozása 'yyyy-MM-dd' startból, N nappal, tisztán UTC-ben.
 */
function buildDateList(startDateStr, days) {
  const parts = String(startDateStr).split('-');
  const year = Number(parts[0]);
  const monthZeroBased = Number(parts[1]) - 1;
  const day = Number(parts[2]);

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const startUTC = new Date(Date.UTC(year, monthZeroBased, day));

  const list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startUTC.getTime() + i * ONE_DAY_MS);
    list.push(Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'));
  }
  return list;
}
