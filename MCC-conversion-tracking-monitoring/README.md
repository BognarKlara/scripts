# Google Ads MCC Konverzió Monitorozó Script

Ez a script segít automatikusan figyelni több Google Ads fiók konverziós adatait egy MCC fiók alatt. Az összes konverziós műveletet is le tudjuk kérdezni (Teljes fiók), vagy egyes konverziós műveleteket is figyelhetünk.

## 🎯 Mire jó ez a script?

1. Ez a script Google Ads MCC-ben a konverziómérés folytonosságát ellenőrzi.
Megnézi, hogy az elmúlt X napban elérte-e a konverziók és/vagy a konverziós értékek száma a beállított minimumot, és csak akkor jelez, ha ez alá esik (pl. mérési hiba, kiesés, import leállás).

2. Opcionálisan 30 napos napi trend riportot is készít fiókonként, grafikonokkal és minimum-javaslatokkal, hogy könnyebb legyen a megfelelő ellenőrzési küszöbök meghatározása.

3. Minden beállítás Google Sheetből vezérelhető, a futás eredményéről a script e-mail értesítést küld.

## 🚀 Telepítés lépésről lépésre

1.  **Google Sheet másolása:**
    
    Másold le a kész template sheetet: **[Template másolása →](https://docs.google.com/spreadsheets/d/1iv1VMcLpIHhhg9qaHKUH--Jn19Qt5AtJe2N6WWv6zFk/copy)**

2.  **Script telepítése:**
    *   Nyisd meg a Google Ads MCC fiókodat.
    *   Menj a **Eszközök** -> **Tömeges műveletek** -> **Szkriptek** menübe.
    *   Kattints a plusz (+) gombra új script létrehozásához.
    *   Nevezd el (pl. "MCC Konverzió Monitor").
    *   Töröld ki az ott lévő üres kódot, és másold be a `mcc-conversion-tracking-monitoring.js` tartalmát.

3.  **Konfiguráció a kódban:**
    A kód **KONFIGURÁCIÓ** részében töltsd ki ezeket a sorokat a saját sheet url-ed címével és saját e-mail címeddel:
    ```javascript
    const SHEET_URL = 'IDE_MÁSOLD_A_GOOGLE_SHEET_URL_CÍMÉT';
    const EMAIL_RECIPIENTS = 'email@cimed.hu';
    ```
    
    *Opcionális beállítások:*
    *   `ENABLE_TREND_REPORT = true`: Ha `true`, akkor generál trend riportokat (ez lassíthatja a futást sok fiók esetén).
    *   `TREND_DAYS = 30`: Hány napos legyen a trend grafikon.

4.  **Engedélyezés és Futtatás:**
    *   Kattints az "Engedélyezés" (Authorize) gombra és hagyd jóvá a jogosultságokat.
    *   Kattints az "Előnézet" (Preview) gombra a teszteléshez.
    *   Ha minden rendben, mentsd el a scriptet és állíts be időzítést, hogy naponta fusson valamilyen reggeli órában.

## 📋 Google Sheet felépítése

### Automatikus fülkezelés

*   **Eredmények fül:** Az első futáskor automatikusan létrejön (ha még nem létezik). A script minden futásnál a **Beállítások fül mögé** helyezi, így a fülek sorrendje mindig ez lesz:
    1. Beállítások
    2. Eredmények
    3. Trend - Ügyfél1 (ha van)
    4. Trend - Ügyfél2 (ha van)
    5. ...

*   **Trend fülek:** Fiókonként automatikusan jönnek létre, ha a `ENABLE_TREND_REPORT = true`.

### Kötelező mezők a Beállítások fülön

**Minden mezőt ki kell tölteni** ahhoz, hogy a sor feldolgozásra kerüljön:

| Oszlop | Kötelező? | Megjegyzés |
|--------|-----------|------------|
| Fiókazonosító | ✅ | 10 jegyű szám (xxx-xxx-xxxx) |
| Ügyfélnév | - | Opcionális, megjelenítéshez |
| Konverziómérés típusa | ✅ | Lásd lentebb |
| Konverziós művelet | ✅ | Pontos név, vagy "TELJES FIÓK" |
| Napok | ✅ | 1-90 közötti szám |
| Elvárt konverziók | ✅ | 0 vagy pozitív szám |
| Elvárt konverziós érték | ✅ | 0 vagy pozitív szám |
| Engedélyezve | - | "Igen" vagy "Nem" (alapértelmezett: Igen) |

> **💡 Tipp:** A `0` érvényes érték! Ha csak a konverziók számát akarod figyelni az érték nélkül, írj 0-t az "Elvárt konverziós érték" mezőbe.

### Hiányos sorok kezelése

Ha egy sorból **bármelyik kötelező mező hiányzik**:
*   A sor **nem kerül feldolgozásra** (kihagyva a monitoringból és a trend riportból)
*   A Google Ads Script naplójában megjelenik, melyik sor és melyik mező hiányzik
*   Az email értesítőben összefoglaló figyelmeztetés jelenik meg: *"⚠️ Figyelem: X sor a Beállítások fülön hiányos vagy hibás volt. Ezeket piros háttérrel jelöltük a Beállítások fülön."*
*   **Vizuális segítség:** A script a Google Sheetben **piros háttérszínnel jelöli** a hiányos sorokat, hogy azonnal kiszúrhasd őket. A javítás után vagy a következő futásnál az elfogadott sorok színezése eltűnik.

Ez lehetővé teszi, hogy fokozatosan töltsd ki a Beállításokat – a félkész sorok nem okoznak hibát, csak kihagyásra kerülnek.

## Melyik konverziómérési típust válasszam?

A script 4 lehetőséget kínál.
```
|-------------------------|-------------------|--------------------|
|                         | Rövid konv. ablak | Hosszú konv. ablak |
|-------------------------|-------------------|--------------------|
| A legtöbb kampányban    |                   |                    |
| elsődleges(ek)          |    Conversions    |    Conversions     |
| a konverzió(k)          |                   |   by conv. time    |
|-------------------------|-------------------|--------------------|
| Több kampányban         |                   |                    |
| nem elsődleges(ek)      |  All Conversions  |  All Conversions   |
| a konverzió(k)          |                   |   by conv. time    |
|-------------------------|-------------------|--------------------|
```

## 📊 Trend Riportok

Ha be van kapcsolva a trend riport funkció, a script minden fiókhoz létrehoz egy külön fület a Google Sheet-ben (pl. `Trend - Ügyfél Neve`).
*   **Grafikon:** Dupla tengelyes grafikonon látod a konverziók számát (bal tengely) és értékét (jobb tengely).
*   **Minimumok:** A script kiemeli a vizsgált időszak legrosszabb napjait.

> **Megjegyzés:** Ha egy fiókhoz nincs egyetlen érvényes (teljesen kitöltött) sor sem, nem jön létre Trend fül a fiókhoz.

### 💡 Javaslatok alacsony volumenű konverziókhoz

Ha egy konverzió napi minimuma **0** (azaz vannak 0 konverziós napok), a script automatikusan **javaslatokat ad** a Trend fülön:

#### Így működik:

1. **Gap analízis:** A script megvizsgálja az egymás utáni 0 konverziós napokat ("gap-ek").
2. **Sliding window számítás:** Minden lehetséges N napos ablakot végignéz, és megkeresi a **legrosszabb esetet** (legkevesebb konverzió).
3. **Két javaslat:**
   - **Konzervatív (max gap + 1):** A leghosszabb csend alapján ajánl napok számát és minimum konverziót.
   - **Érzékenyebb (medián + 1):** A mediángap alapján (csak ha van legalább 3 gap adat).

#### Példa a megjelenítésre:

```
📊 Javaslatok alacsony volumen esetén (másolható értékek):

| Javaslat típus              | Napok | Min konv | Min érték |
|----------------------------|-------|----------|-----------|
| Konzervatív (max gap + 1)  | 14    | 1        | 75        |
| Érzékenyebb (medián + 1)   | 4     | 1        | 75        |

💡 Számítás: minden lehetséges N napos ablak konverziószámának minimuma (worst-case védelem).
```

#### Hogyan használd:

1. Nyisd meg a Trend fület az adott fiókhoz.
2. Keresd meg az alacsony volumenű konverziót.
3. Másold át a javasolt értékeket (Napok, Min konv, Min érték) a **Beállítások** fülre.
4. A script ezután ezen értékek alapján fog riasztást küldeni.

#### Fontos megjegyzések:

- **Worst-case védelem:** A javaslat a legrosszabb történelmi adatokat veszi alapul → konzervatív, de biztonságos.
- **Érték számítás:** Átlagos érték per konverzió × várható konverziók.
- **Medián csak 3+ gap esetén:** Ha kevés adat van (< 3 gap), csak a konzervatív javaslat jelenik meg.

## ⚠️ Fontos tudnivalók

*   **Időlimit:** A Google Ads scriptek maximum **30 percig** futhatnak. Ha nagyon sok (pl. 50+) fiókot és szabályt állítasz be, és a trend riport is be van kapcsolva, a script kifuthat az időből. Ilyenkor érdemes kikapcsolni a trend riportot (`ENABLE_TREND_REPORT = false`).
*   **Dátumok:** A script mindig a "tegnapi" nappal záruló időszakot vizsgálja, hogy teljes napokat lásson.
