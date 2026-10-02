import type { PixelToolkitApi } from '../shared/api';

declare global {
  interface Window {
    api: PixelToolkitApi;
  }
}
