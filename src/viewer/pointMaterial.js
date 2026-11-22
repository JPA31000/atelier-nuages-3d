// Matériau des points (WebGL2) : 4 modes de couleur (RVB, élévation, intensité, par nuage),
// taille fixe en pixels ou adaptative à la distance (mètres), points ronds, opacité (superposition panoramique).

import * as THREE from 'three';

export const COLOR_MODES = { rgb: 0, elevation: 1, intensity: 2, cloud: 3 };

/** Uniformes PARTAGÉS par tous les nuages : modifier une valeur met à jour tous les matériaux. */
export const shared = {
  uSize: { value: 2.5 },
  uScale: { value: 800 },
  uAdaptive: { value: 0 },
  uPixelRatio: { value: 1 },
  uMode: { value: 0 },
  uZRange: { value: new THREE.Vector2(0, 1) },
  uOpacity: { value: 1 },
};

const vertexShader = /* glsl */ `
attribute vec3 aColor;
attribute float aIntensity;
uniform float uSize;
uniform float uScale;
uniform float uAdaptive;
uniform float uPixelRatio;
uniform float uMode;
uniform vec2 uZRange;
uniform vec3 uCloudColor;
uniform float uHasColor;
uniform float uHasIntensity;
varying vec3 vColor;

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.267, 0.005, 0.329);
  vec3 c1 = vec3(0.230, 0.322, 0.546);
  vec3 c2 = vec3(0.128, 0.567, 0.551);
  vec3 c3 = vec3(0.369, 0.789, 0.383);
  vec3 c4 = vec3(0.993, 0.906, 0.144);
  if (t < 0.25) return mix(c0, c1, t * 4.0);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) * 4.0);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) * 4.0);
  return mix(c3, c4, (t - 0.75) * 4.0);
}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.0001);
  float s = uAdaptive > 0.5 ? uSize * uScale / depth : uSize;
  gl_PointSize = clamp(s * uPixelRatio, 1.0, 48.0 * uPixelRatio);
  if (uMode < 0.5) {
    vColor = uHasColor > 0.5 ? aColor : vec3(0.78);
  } else if (uMode < 1.5) {
    float z = (modelMatrix * vec4(position, 1.0)).z;
    vColor = ramp((z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-6));
  } else if (uMode < 2.5) {
    vColor = uHasIntensity > 0.5 ? vec3(pow(aIntensity, 0.8)) : vec3(0.6);
  } else {
    vColor = uCloudColor;
  }
}
`;

const fragmentShader = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(vColor, uOpacity);
}
`;

export function makePointMaterial(cloud) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uCloudColor: { value: new THREE.Color(cloud.color) },
      uHasColor: { value: cloud.colors ? 1 : 0 },
      uHasIntensity: { value: cloud.intensity ? 1 : 0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: true,
  });
}
