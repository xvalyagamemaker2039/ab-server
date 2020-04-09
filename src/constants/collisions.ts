export const MAP_SIZE = {
  WIDTH: 32768,
  HEIGHT: 16384,

  HALF_WIDTH: 32768 / 2,
  HALF_HEIGHT: 16384 / 2,
};

export const MAP_COORDS = {
  MIN_X: -MAP_SIZE.WIDTH / 2,
  MIN_Y: -MAP_SIZE.HEIGHT / 2,
  MAX_X: MAP_SIZE.WIDTH / 2,
  MAX_Y: MAP_SIZE.HEIGHT / 2,
};

export const COLLISIONS_MAP_COORDS = {
  MIN_X: 0,
  MIN_Y: 0,
  MAX_X: MAP_SIZE.WIDTH,
  MAX_Y: MAP_SIZE.HEIGHT,
};

export const COLLISIONS_OBJECT_TYPES = {
  FLAGZONE: 1,
  FLAG: 2,
  SHIELD: 3,
  PROJECTILE: 4,
  INFERNO: 5,
  UPGRADE: 6,
  MOUNTAIN: 7,
  REPEL: 8,
  PLAYER: 9,
  VIEWPORT: 10,
  FIREWALL: 11,
};

export const COLLISIONS_OBJECT_SHAPES = {
  CIRCLE: 0,
  RECTANGLE: 1,
};
