Po dalszej analizie doprecyzowuję docelowy model wariantów i rewizji w Cascadii.

Nasza nomenklatura:

- `P3001` — bazowy numer rodziny produktu,
- `V1` — wariant konstrukcyjny wynikający z zastosowanych podzespołów,
- `R2` — rewizja konkretnego wariantu `P3001V1`,
- `MK1` — wykonanie wariantu, np. kolor obudowy i malowanie szybki.

Pełne oznaczenie produkcyjne ma postać:

`P3001V1R2MK1`

Analogicznie dokumentacja PCB:

- `B3004` — stały numer dokumentacji/zespołu PCB,
- `R2` — rewizja PCB, wspólna dla wszystkich wykonań,
- `MK1` — wykonanie/obsadzenie w ramach rewizji.

Pełne oznaczenie:

`B3004R2MK1`

Najważniejsza reguła: rewizja należy do wariantu, a nie do wykonania MK. Dla przykładu oba wykonania:

- `P3001V1R2MK1`,
- `P3001V1R2MK2`

muszą zawsze mieć tę samą rewizję `R2`. System nie może dopuścić do stanu, w którym MK1 ma R3, a MK2 nadal R2.

Proszę przeanalizować możliwość rozszerzenia modelu Part o pierwszoklasowe pojęcia:

```text
Part Family
└─ Variant — rewizjonowany
   └─ Execution/MK — nierewizjonowane wykonanie
```

Przykładowa struktura:

```text
P3001 — Part Family / Family Design
├─ P3001V1 — wyświetlacz, 8 przycisków
│  ├─ Revision R0, R1, R2...
│  ├─ MK1 — czarny
│  └─ MK2 — biały
├─ P3001V2 — wyświetlacz, 7 przycisków
│  ├─ MK1 — czarny
│  └─ MK2 — biały
├─ P3001V3 — bez wyświetlacza, 3 przyciski
│  ├─ MK1 — czarny
│  └─ MK2 — biały
└─ P3001V4 — bez wyświetlacza, 2 przyciski
   ├─ MK1 — czarny
   └─ MK2 — biały
```

Design powinien pozostać kontenerem projektu, branchy, commitów i ECO. Wariant i wykonanie powinny należeć do modelu Part, ponieważ dotyczą fizycznego produktu, BOM-u, SKU i `where-used`.

BOM powinien umożliwiać rozdzielenie części wspólnej wariantu od nadpisań wykonania:

```text
P3001V1 R2 — BOM wspólny
├─ B3001 — dolna PCB
└─ B3004 — górna PCB z wyświetlaczem

MK1 — wykonanie czarne
├─ obudowa czarna
└─ szybka D8 czarna

MK2 — wykonanie białe
├─ obudowa biała
└─ szybka D8 biała
```

Rozwiązany BOM produkcyjny powinien łączyć BOM wariantu z nadpisaniami wybranego MK.

Wymagania funkcjonalne:

1. Variant posiada własny stabilny identyfikator i historię rewizji.
2. Execution/MK należy do Variantu i nie posiada niezależnego licznika rewizji.
3. Wydanie nowej rewizji Variantu automatycznie obowiązuje wszystkie aktywne wykonania MK.
4. System generuje pełne oznaczenie, np. `P3001V1R2MK1`.
5. Schemat rewizji powinien obsługiwać `R0 → R1 → R2`, czyli `prefixed-numeric` z konfigurowalnym `startAt: 0`.
6. Zmiana wspólnego BOM-u wariantu wymaga jego nowej rewizji.
7. Zmiana wykonania powinna być kontrolowana przez ECO/MCO; wydanego wykonania nie można edytować bez śladu.
8. `where-used` i impact assessment powinny działać na rozwiązanym BOM-ie.
9. Zmiana `B3001` wpływa na wszystkie warianty produktu.
10. Zmiana `B3004` wpływa tylko na warianty z wyświetlaczem.
11. Zmiana `B3042` wpływa tylko na warianty bez wyświetlacza.
12. Należy zachować kompatybilność i przygotować migrację istniejących Partów `P3001V1MK1`, `P3001V1MK2` itd.
13. Proszę dodać testy jednostkowe i integracyjne dla rewizji, wykonywania ECO, generowania pełnych oznaczeń oraz rozwiązywania BOM-u.

Jeżeli pełny model `PartVariant` i `VariantExecution` wymaga zbyt szerokiej przebudowy, proszę najpierw zaproponować wariant minimalny oparty na obecnym Part i atrybutach:

```yaml
familyCode: P3001
variantCode: V1
executionCode: MK1
revisionGroupKey: P3001V1
```

W wersji minimalnej backend ECO musi traktować wszystkie Parts z tym samym `revisionGroupKey` jako jedną domenę rewizyjną.

Najpierw przeanalizuj aktualny model danych, RevisionService, ECO merge, BOM relationships i istniejące zmiany w repozytorium. Następnie przedstaw rekomendowaną architekturę, zakres migracji i ryzyka. Nie implementuj dużej migracji schematu, dopóki nie porównasz wariantu minimalnego z docelowym.

---

## Decyzja architektoniczna

Po analizie odrzucono model minimalny, w którym każde MK byłoby osobnym
`Partem` połączonym jedynie przez `revisionGroupKey`. Obecny merge ECO działa na
pojedynczych `masterId`, więc taki model wymagałby rozproszonej transakcji
wydania kilku Partów i nadal pozwalałby utworzyć stan `MK1=R3`, `MK2=R2`.

Przyjęty model jest pierwszoklasowy:

```text
part_families
└─ part_variants                 (jeden stabilny items.master_id typu Part)
   └─ part_variant_executions    (migawka należąca do konkretnego items.id)
      └─ part_variant_execution_bom_lines
```

- Variant jest zwykłym rewizjonowanym Partem. Jego `items.master_id` jest
  stabilną tożsamością, a `items.revision` jedynym źródłem rewizji.
- Execution nie ma kolumny rewizji. `execution_master_id` identyfikuje to samo
  MK w kolejnych rewizjach Variantu, natomiast każdy `items.id` posiada własną
  migawkę wykonania.
- Utworzenie kopii roboczej, rebase oraz wydanie nowej rewizji kopiuje wszystkie
  aktywne i nieaktywne wykonania wraz z ich BOM-em. Stara rewizja nie jest
  modyfikowana.
- Zmiana MK przechodzi przez tę samą blokadę edycji Partu co wspólny BOM. Po
  wydaniu wymaga więc checkoutu/ECO (lub odpowiedniej ścieżki dozwolonej przez
  lifecycle).
- Stabilne powiązanie Family/Variant można skonfigurować tylko przed pierwszym
  wydaniem Partu. Nie jest ono wersjonowaną treścią i nie może pojawić się na
  `main` wskutek edycji odrzuconej gałęzi ECO.

## BOM i analiza wpływu

Wspólny BOM Variantu pozostaje w `item_relationships` jako relacje `BOM`.
Pierwsza wersja wykonania dodaje do niego pozycje z
`part_variant_execution_bom_lines`. Resolved BOM jest sumą:

```text
common Variant BOM + additions for selected active MK
```

System blokuje umieszczenie tego samego mastera Partu jednocześnie w BOM-ie
wspólnym i specyficznym dla MK. Cele obu rodzajów relacji są rozwiązywane w
kontekście brancha, a przy merge ECO przepinane na rewizje wydane w tej samej
transakcji.

`where-used` oraz podstawowy impact assessment traktują aktywne wykonania jako
konserwatywną sumę możliwych użyć. Dzięki temu zmiana elementu występującego
tylko w MK nadal wskaże Variant nadrzędny. Jeżeli różne MK używają tego samego
elementu z różną ilością, ogólny widok pokazuje największą ilość. Widok
resolved BOM dla konkretnego MK zachowuje jego dokładną ilość.

W tej wersji nie ma operacji usunięcia ani zastąpienia linii wspólnego BOM-u
przez MK. Wymaga to stabilnej tożsamości linii BOM kopiowanej między rewizjami;
obecne `item_relationships` identyfikuje linię przez parę source/target. Do
czasu dodania takiej tożsamości wykonania obsługują bezpieczny, jednoznaczny
wariant addytywny pokazany w przykładzie powyżej.

## Oznaczenia i revision scheme

Schematy `numeric` oraz `prefixed-numeric` przyjmują opcjonalne `startAt`.
Domyślna wartość pozostaje równa `1` dla kompatybilności. Konfiguracja:

```json
{ "type": "prefixed-numeric", "prefix": "R", "startAt": 0 }
```

daje sekwencję `R0 → R1 → R2`. Pełne oznaczenie jest wyliczane, a nie
zapisywane niezależnie: `familyCode + variantCode + Part.revision + MK.code`.
Kopia robocza jest wyświetlana jako `DRAFT`, aby nie wyglądała jak oznaczenie
produkcyjne.

## Migracja i kompatybilność

Migracja `0004_product_variants.sql` jest addytywna: tworzy nowe tabele i nie
zmienia istniejących Partów ani ich BOM-ów. Dotychczasowe części
`P3001V1MK1`, `P3001V1MK2` nadal działają jako zwykłe, niezależne Party.

Automatyczny backfill wyłącznie z `item_number` byłby niebezpieczny. Numer nie
pozwala rozstrzygnąć, który BOM jest wspólny, które linie są właściwe dla MK,
która z rozbieżnych rewizji ma zostać bazą ani czy podobna końcówka rzeczywiście
oznacza wykonanie. Migracja istniejącej rodziny powinna być jawna:

1. wybrać kanoniczny Part dla każdego Variantu i uzgodnić jego rewizję,
2. podzielić BOM-y legacy na część wspólną i dodatki każdego MK,
3. skonfigurować Family/Variant na niewydanej kopii przygotowanej do migracji,
4. utworzyć MK i przypisać dodatki przez API,
5. zweryfikować każdy resolved BOM względem poprzedniego Partu,
6. po zatwierdzeniu oznaczyć stare, niezależne Party jako obsolete.

Taki backfill powinien korzystać z zatwierdzonego pliku mapowania, a nie z
heurystyki numeru. Dla instalacji bez danych wariantowych wystarcza zwykłe
`db:migrate`; istniejąca instalacja nie wymaga przebudowy dotychczasowych
rekordów.

## Zakres kolejnych etapów

- replace/remove wspólnej linii BOM przez wykonanie,
- przypięcie Work Order i Physical Part do `execution_master_id`,
- raport impact wskazujący konkretne kody MK zamiast wyłącznie Variantu,
- wspomagany importer legacy oparty na zatwierdzonym pliku mapowania.
