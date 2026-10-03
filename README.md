# EuroDrive 3D v0.3 – Real Start Meinerzhagen

Diese Version startet an **Löher Weg 2A, 58540 Meinerzhagen** und fährt zum **Kölner Dom**.

## Was in v0.3 real ist
- Start- und Zieladresse werden beim Laden live über OpenStreetMap/Nominatim aufgelöst.
- Route wird über OSRM auf tatsächlich befahrbaren OSM-Straßen berechnet.
- Karten- und Straßenlage stammt aus OpenStreetMap/OpenFreeMap.
- Gelände wird über Mapterhorn als 3D-Höhenmodell geladen.
- Gebäude werden, soweit im Kartenstil verfügbar, aus echten Kartengeometrien extrudiert.
- Tankstellen werden entlang der Route aus OpenStreetMap/Overpass geladen.

## Absichtlich keine Fantasie-Ersatzdaten
Wenn Startadresse, Zieladresse oder Route nicht geladen werden können, zeigt die App einen Fehler. Sie setzt **keine erfundene Ersatzroute** ein.

## Noch nicht 1:1 fotorealistisch
Fassaden, Vegetation, Straßenmöblierung und einzelne Objekte entsprechen noch nicht vollständig der realen Optik. Positionen und Geografie basieren auf offenen Geodaten.

## Start
Die Datei `index.html` über GitHub Pages oder einen lokalen Webserver öffnen. Direkter Datei-Aufruf (`file://`) kann externe Kartendienste blockieren.

Kartendaten © OpenStreetMap-Mitwirkende. Karte: OpenFreeMap. Gelände: Mapterhorn. Routing: OSRM-Demo-Server.
