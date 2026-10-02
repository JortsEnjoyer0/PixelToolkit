// Testbed documents: one mock DocHandle per fixture, built exactly like the app's "pick reference + Estimate Skeleton"
// path (createAnimationMeta → withReferenceImage → withEstimate), plus a DocSource whose images are the fixture PNGs.
import { uid } from '@shared/uid';
import { createAnimationMeta } from '../core/model';
import { stateFromMeta, withEstimate, withReferenceImage, type EstimateReport } from '../core/docState';
import type { DocSource } from '../editor/types';
import { createMockDoc } from '../stores/mockDoc';
import { docSourceFromHandle } from '../tools/skelanim/editor/docSource';
import type { DocHandle } from '../stores/types';
import type { EstimateFixture } from './fixtures';

export interface TestbedDoc {
  doc: DocHandle;
  src: DocSource;
  fixture: EstimateFixture;
  /** Uid standing in for the reference image (resolves to the fixture PNG). */
  refUid: string;
  report: EstimateReport;
}

export function buildFixtureDoc(fx: EstimateFixture): TestbedDoc {
  const canvas = fx.estimate.canvas;
  const meta = createAnimationMeta({ direction: fx.direction, canvas, action: 'idle', description: fx.label });
  const refUid = uid();
  const withImage = withReferenceImage(stateFromMeta(meta), { image: refUid, sourceBaseUid: null, width: canvas.width, height: canvas.height });
  const est = withEstimate(withImage, fx.estimate.keypoints, { resetFrames: true });
  const doc = createMockDoc({ ...meta, ...est.state }, { name: fx.label, charRel: 'Testbed' });
  const urls = new Map([[refUid, fx.imageUrl]]);
  const src = docSourceFromHandle(doc, (u) => urls.get(u) ?? fx.imageUrl);
  return { doc, src, fixture: fx, refUid, report: est.report };
}
