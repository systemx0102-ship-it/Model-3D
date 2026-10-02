# Hero Character — personaje femenino en tiempo real

Personaje femenino adulto completo para juego en tiempo real, generado de forma procedimental y
reproducible: malla anatómica, rig compatible con UE5, 52 blendshapes ARKit, piel con dispersión
subsuperficial, pelo por hebras con física, ropa con grosor real, camisa de franela con
simulación de tela, locomoción procedimental con IK de pies y manos, animación facial y LODs.

Todo el contenido se genera a partir de los assets CC0 de MakeHuman (`third_party/makehuman`)
y del código de este repositorio; no se usa código AGPL.

## Ver el modelo

```bash
npm install
npm run dev          # abre http://127.0.0.1:5173
```

O, con la versión ya compilada (`dist/`), cualquier servidor estático:

```bash
npx vite preview     # o: python3 -m http.server -d dist 8080
```

> Los archivos `.glb` y las texturas se cargan con `fetch`, así que hay que servirlos por HTTP:
> abrir `dist/index.html` con doble clic (`file://`) no funciona.

**Controles**: el visor arranca con un recorrido automático (reposo, caminar, trotar, correr,
esprintar, giros de 90/180°, escaleras, caída, agacharse, apuntar). Al pulsar cualquier tecla
pasa a control manual: `WASD` mover · `Shift` esprintar · `Ctrl` caminar · `Espacio` saltar ·
`C` agacharse · `F` apuntar · `Q/E/T` girar · arrastrar para orbitar la cámara.

El panel de la derecha permite elegir cámara, expresión facial e intensidad, hacer hablar al
personaje con sincronía labial, cambiar iluminación y exposición, viento, frecuencia de la
física (60/120 Hz), ver colisionadores, ocultar prendas, forzar LOD y ver estadísticas.

Parámetros útiles en la URL: `?view=face|face34|profile|eye|mouth|hand|feet|torso|back|side|full`,
`?light=studio|overcast|sunset|night`, `?anim=idle|walk|jog|run|sprint|crouch|aim|turn`,
`?expr=happy`, `?say=texto`, `?wind=8`, `?lod=0..3`, `?simhz=60`, `?colliders`, `?manual`.

## Qué incluye

| Área | Implementación |
| --- | --- |
| Geometría | Malla base anatómica (MakeHuman hm08) con asimetría natural, ojos con córnea/iris/esclera, línea lagrimal, pestañas y cejas por hebras, dientes, encías y lengua separados; UVs reempaquetadas en Head/Body/Limbs |
| Rig | Esqueleto con nombres de UE5 Mannequin (pelvis, spine_01–05, neck_01–02, head, clavículas, brazos, dedos completos, piernas, dedos de los pies) + huesos de torsión y bones auxiliares (ojos, mandíbula, pecho, bolsa) |
| Cara | 52 blendshapes ARKit (nombres compatibles con Live Link Face) + respiración; expresiones (neutral, feliz, triste, enfado, sorpresa, miedo, asco, confusión, dolor, media sonrisa), visemas, micro-expresiones, parpadeos log-normales, sacadas, vergencia, párpados que siguen la mirada, mapas de arrugas |
| Piel | Texturas horneadas (BaseColor, ORM, Normal, Height, cavidad, translucidez, microdetalle), poros, pecas, venas; shader con SSS preintegrado, penumbra coloreada, retrodispersión, doble lóbulo especular, rubor por esfuerzo |
| Ojos | Refracción de córnea con profundidad de iris, humedad, menisco lagrimal, pupila reactiva a la luz |
| Pelo | ~40 000 hebras renderizadas en GPU, interpoladas desde 289 guías simuladas (zonas raíz/medio/punta, inercia, amortiguación, arrastre, gravedad, viento con ráfagas, colisión con cabeza, cuello, hombros, pecho, espalda y brazos), BSDF de Marschner/Karis, flequillo, mechones laterales, pelusa y baby hairs |
| Ropa | Camiseta de punto acanalado, pantalón cargo de sarga, botas de cuero con suela de goma, cinturón con hebilla y riñonera — todas con grosor real (pared exterior, interior y dobladillos), costuras, pespuntes, bolsillos, pliegues, cordones con ojales, desgaste; detalle de tejido triplanar en espacio de bind |
| Tela simulada | Camisa de franela atada a la cintura: XPBD (estiramiento, cizalla, flexión), amarres de largo alcance, aerodinámica por triángulo, colisión con caderas, glúteos, piernas y riñonera, inercia, reinicio ante teletransporte; mangas colgando del nudo |
| Animación | Locomoción procedimental con fases y pies plantados en el mundo, arranque/parada, giros en el sitio, salto/caída/aterrizaje (duro), agacharse, escaleras y pendientes; IK de dos huesos para pies y manos, ajuste de pelvis, contrarrotación, balanceo de brazos, estabilización de cabeza, look-at distribuido, capa de reposo (respiración, cambio de peso, tragar), apuntado con objeto en la mano; la raíz se desplaza con la propia locomoción (root motion procedimental) |
| Física estable | Pelo y tela en paso fijo de 120 Hz con interpolación de entradas y de render: mismo resultado a 30, 60 y 120 FPS (ver tests). Paso de 60 Hz opcional/automático con constantes convertidas |
| LODs | LOD0 115k · LOD1 71k · LOD2 22k · LOD3 7k triángulos (intercambio de índices en tiempo real) + `hero_LOD1..3.glb` independientes para motores; el pelo reduce hebras y aumenta su anchura |

## Estructura

```
character/          receta del personaje (proporciones, asimetría, tonos) y línea del pelo
tools/              pipeline de generación (build-character.mjs y tools/lib/*)
src/                visor/runtime (three.js): render/, character/, anim/, physics/, ui/
public/character/   asset generado: hero.glb, hero_LOD*.glb, character.json, hair.bin, lods.bin, textures/
test/               tests (node --test)
third_party/        assets CC0 de MakeHuman (ver LICENSE.ASSETS.md)
```

Regenerar el asset: `npm run build:character` (≈4 min). Opciones: `--tex 4096` o `--tex 8192`
para texturas de piel en 4K/8K, `--png` para exportar también PNG (y altura de 16 bits),
`--notex` para no rehornear la piel.

Tests: `npm test` — independencia de la tasa de fotogramas (30/60/120) de tela y pelo,
determinismo, inextensibilidad, estabilidad sin NaN ante movimiento violento, viento extremo y
teletransporte, y validación de blendshapes/visemas/expresiones.

## Uso en motores

- **Unreal Engine 5**: importar `hero.glb` (Interchange glTF) como Skeletal Mesh. Los nombres de
  huesos siguen al UE5 Mannequin, así que IK Rig + IK Retargeter permiten reutilizar animaciones
  del Mannequin/MetaHuman; las curvas ARKit funcionan con Live Link Face. Importar
  `hero_LOD1..3.glb` como LODs adicionales. Pelo: `hair.bin` contiene guías e interpolación
  (formato documentado en `character.json → hair.layout`); para Groom hace falta convertir las
  guías a Alembic (no incluido). Tela: recrear la camisa con Chaos Cloth usando la malla
  `SK_ShirtTie` y los datos `overshirt` del sidecar.
- **Unity HDRP**: importar el GLB (glTFast); las texturas ORM se mapean a Mask Map (R=AO,
  G=roughness → invertir a smoothness, B=metal).
- **Blender / Maya**: importar el GLB (importador glTF nativo de Blender; en Maya vía plugin glTF
  o convirtiendo a FBX desde Blender). Los blendshapes llegan como shape keys/blendShapes con sus
  nombres ARKit.

## Limitaciones honestas

- Es un personaje **procedimental**, no un escaneado: el realismo depende de shaders y texturas
  horneadas por código, no de fotogrametría; de cerca no alcanza a un MetaHuman.
- La malla parte de la topología de MakeHuman (quads limpios con loops de animación), no de un
  retopo artesanal; la versión "high-poly" se obtiene subdividiendo, no hay esculpido.
- Solo la camisa atada y el pelo están simulados; camiseta, pantalón y botas son skinned con
  pliegues horneados en las texturas. No hay autocolisión de tela.
- El pelo no tiene tarjetas (hair cards) para LODs lejanos: se reducen hebras. No se exporta
  Alembic para Groom.
- En LOD3 (personaje muy pequeño en pantalla) puede asomar algo de piel en el escote de la
  camiseta.
- No hay modo de animación in-place ni clips exportables (FBX/BVH): la locomoción es procedimental
  y se genera en tiempo real.
- La física del pelo es exigente en CPU: el visor baja a 60 Hz automáticamente si no llega.
- Verificado en Chromium (renderizado por software en un entorno sin GPU); el rendimiento real
  depende del equipo.

## Licencias

Código: MIT. Assets base: MakeHuman CC0 (ver `third_party/makehuman/LICENSE.ASSETS.md`).
