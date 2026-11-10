import { useId } from "react";

/** Peaks rise from the water line at y = 300 of a 1440 × 360 canvas: steep sides and
 *  domed tops, tall at both ends and low in the middle, so the valley stays open
 *  behind centered content. */
const FAR_PEAKS =
  "M-48 300C-28 250 -12 150 29 150S72 250 92 300ZM98 300C107 216 114 110 145 110S193 216 202 300Z" +
  "M162 300C185 265 199 172 239 172S279 265 302 300ZM286 300C292 219 303 136 330 136S368 219 374 300Z" +
  "M340 300C370 277 384 196 427 196S466 277 496 300ZM444 300C490 293 488 238 540 238S590 293 636 300Z" +
  "M608 300C625 272 627 216 662 216S711 272 728 300ZM680 300C738 297 743 254 801 254S842 297 900 300Z" +
  "M847 300C860 263 875 204 910 204S950 263 963 300ZM939 300C945 226 952 150 980 150S1025 226 1031 300Z" +
  "M996 300C1026 276 1039 190 1084 190S1126 276 1156 300ZM1128 300C1136 214 1150 116 1180 116S1220 214 1228 300Z" +
  "M1188 300C1212 264 1212 168 1255 168S1312 264 1336 300ZM1304 300C1313 230 1327 140 1356 140S1391 230 1400 300Z" +
  "M1370 300C1387 260 1392 178 1427 178S1473 260 1490 300Z";
const MID_PEAKS =
  "M-88 300C-62 274 -46 204 0 204S46 274 72 300ZM54 300C72 261 87 182 124 182S164 261 182 300Z" +
  "M166 300C173 232 186 154 214 154S251 232 258 300ZM212 300C246 287 240 222 284 222S338 287 372 300Z" +
  "M330 300C364 294 369 250 407 250S436 294 470 300ZM964 300C1000 294 991 246 1032 246S1080 294 1116 300Z" +
  "M1070 300C1097 280 1108 210 1147 210S1183 280 1210 300ZM1186 300C1193 235 1201 162 1229 162S1271 235 1278 300Z" +
  "M1252 300C1272 267 1287 200 1328 200S1372 267 1392 300ZM1362 300C1388 277 1388 216 1434 216S1496 277 1522 300Z";
const NEAR_PEAKS =
  "M6 300C45 290 55 240 105 240S147 290 186 300ZM146 300C154 257 161 202 188 202S226 257 234 300Z" +
  "M192 300C228 296 235 260 276 260S308 296 344 300ZM1100 300C1138 296 1129 262 1172 262S1222 296 1260 300Z" +
  "M1220 300C1228 260 1239 208 1265 208S1296 260 1304 300ZM1258 300C1297 290 1290 242 1339 242S1399 290 1438 300Z";
/** Ripples across the reflection, in the ground color. */
const RIPPLES = "M0 311H1440M0 321H1440M0 330H1440M0 338H1440M0 345H1440M0 351H1440";

/** The brand picture: the karst peaks of Guilin, where the 灵渠 canal runs, mirrored in
 *  still water. Decorative only; every color comes from the `--peak-*` theme variables
 *  through the `.landscape-*` classes in App.css. */
export function LandscapeBackdrop({ className = "" }: { className?: string }) {
  const id = useId();
  const mist = `${id}-mist`;
  const water = `${id}-water`;
  return (
    <svg className={`landscape ${className}`.trim()} viewBox="0 0 1440 360" preserveAspectRatio="xMidYMax slice" aria-hidden focusable="false">
      <defs>
        <linearGradient id={mist} x1="0" y1="150" x2="0" y2="300" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="landscape-mist-clear" />
          <stop offset="1" className="landscape-mist-full" />
        </linearGradient>
        <linearGradient id={water} x1="0" y1="300" x2="0" y2="360" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="landscape-mist-clear" />
          <stop offset="1" className="landscape-mist-full" />
        </linearGradient>
      </defs>
      <circle className="landscape-sun" cx="1034" cy="176" r="36" />
      <path className="landscape-far" d={FAR_PEAKS} />
      <rect x="0" y="150" width="1440" height="150" fill={`url(#${mist})`} opacity="0.7" />
      <path className="landscape-mid" d={MID_PEAKS} />
      <rect x="0" y="150" width="1440" height="150" fill={`url(#${mist})`} opacity="0.45" />
      <path className="landscape-near" d={NEAR_PEAKS} />
      <g className="landscape-reflection" transform="translate(0 300) scale(1 -0.36) translate(0 -300)">
        <path className="landscape-far" d={FAR_PEAKS} />
        <path className="landscape-mid" d={MID_PEAKS} />
        <path className="landscape-near" d={NEAR_PEAKS} />
      </g>
      <path className="landscape-ripples" d={RIPPLES} />
      <rect x="0" y="300" width="1440" height="60" fill={`url(#${water})`} />
    </svg>
  );
}
