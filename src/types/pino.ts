// eslint-disable-next-line import/no-extraneous-dependencies
import SonicBoom from 'sonic-boom';

interface DestinationArgs {
  dest?: string | number;
  minLength?: number;
  sync?: boolean;
}

declare module 'pino' {
  function destination(args: DestinationArgs): SonicBoom;
}
