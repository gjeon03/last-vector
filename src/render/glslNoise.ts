/**
 * Shared GLSL noise. Hash-based so nothing depends on a texture upload, which keeps the
 * build asset-free and makes every procedural surface identical across machines.
 */
export const GLSL_NOISE = /* glsl */ `
  // Dave Hoskins' hash. The classic sin-based gradient hash costs three transcendentals per
  // call, and gradient noise calls it eight times per octave — a three-octave fbm on a rock
  // surface was issuing well over two hundred sin() per pixel, which is what pinned the frame
  // to the fragment shader. This is pure multiply/fract and measurably faster for identical
  // visual quality.
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
  }

  float hash13(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  // Gradient noise: smoother and less grid-aligned than value noise, which matters a lot
  // when the result is stretched across a whole sky.
  float gnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dot(hash33(i + vec3(0, 0, 0)), f - vec3(0, 0, 0)),
                       dot(hash33(i + vec3(1, 0, 0)), f - vec3(1, 0, 0)), u.x),
                   mix(dot(hash33(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)),
                       dot(hash33(i + vec3(1, 1, 0)), f - vec3(1, 1, 0)), u.x), u.y),
               mix(mix(dot(hash33(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)),
                       dot(hash33(i + vec3(1, 0, 1)), f - vec3(1, 0, 1)), u.x),
                   mix(dot(hash33(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)),
                       dot(hash33(i + vec3(1, 1, 1)), f - vec3(1, 1, 1)), u.x), u.y), u.z);
  }

  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    // Rotating between octaves breaks up the axis-aligned streaking of stacked noise.
    mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      sum += amp * gnoise(p);
      p = rot * p * 2.02;
      amp *= 0.5;
    }
    return sum;
  }

  /** Ridged variant: gives the filament structure that reads as gas rather than fog. */
  float ridged(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float prev = 1.0;
    mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      float n = 1.0 - abs(gnoise(p));
      n *= n;
      sum += n * amp * prev;
      prev = n;
      p = rot * p * 2.02;
      amp *= 0.5;
    }
    return sum;
  }
`;
