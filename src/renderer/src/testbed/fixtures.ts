// Testbed fixtures (written by `npm run fixtures`): padded sprites from assets/test_imgs plus their real
// estimate-skeleton responses. Static imports, no IPC. Node scripts read testbed/fixtures/*.json directly instead.
import type { Direction, EstimateFixtureFile } from '@shared/pixellab';
import merchantSouthJson from '../../../../testbed/fixtures/mechant_downfacing_truepixel_128.estimate.json';
import merchantSouthUrl from '../../../../testbed/fixtures/mechant_downfacing_truepixel_128.png?url';
import merchantEastJson from '../../../../testbed/fixtures/merchant_rightfacing_truepixel_128.estimate.json';
import merchantEastUrl from '../../../../testbed/fixtures/merchant_rightfacing_truepixel_128.png?url';
import peasantSouthJson from '../../../../testbed/fixtures/peasantboy2_facingcamera_turepixel_162x151.estimate.json';
import peasantSouthUrl from '../../../../testbed/fixtures/peasantboy2_facingcamera_turepixel_162x151.png?url';
import peasantEastJson from '../../../../testbed/fixtures/peasantboy_rightfacing_truepixel_128.estimate.json';
import peasantEastUrl from '../../../../testbed/fixtures/peasantboy_rightfacing_truepixel_128.png?url';

export interface EstimateFixture {
  /** Fixture file basename. */
  name: string;
  /** Short display label. */
  label: string;
  /** Facing of the sprite (from its file name). */
  direction: Direction;
  /** URL of the padded PNG (exactly the bytes that were estimated). */
  imageUrl: string;
  estimate: EstimateFixtureFile;
}

const fx = (name: string, label: string, direction: Direction, imageUrl: string, json: unknown): EstimateFixture =>
  ({ name, label, direction, imageUrl, estimate: json as EstimateFixtureFile });

export const FIXTURES: readonly EstimateFixture[] = [
  fx('mechant_downfacing_truepixel_128', 'Merchant south 128', 'south', merchantSouthUrl, merchantSouthJson),
  fx('merchant_rightfacing_truepixel_128', 'Merchant east 128', 'east', merchantEastUrl, merchantEastJson),
  fx('peasantboy2_facingcamera_turepixel_162x151', 'Peasant boy south 162x151 → 256', 'south', peasantSouthUrl, peasantSouthJson),
  fx('peasantboy_rightfacing_truepixel_128', 'Peasant boy east 128', 'east', peasantEastUrl, peasantEastJson)
];
