import * as THREE from 'three';
import type { Vec3 } from '../types';

// In-world text for the training range: canvas-texture sprites (always face
// the camera). Pad signs carry a challenge's name, rules and your best; small
// labels mark gallery distances and course gates. Drawn with the game's
// display font; redrawn once web fonts finish loading.

export type SignText = { title: string; sub?: string; foot?: string; accent: string };

const FONT_DISPLAY = '"Chakra Petch", "Geist", system-ui, sans-serif';
const FONT_BODY = '"Geist", system-ui, sans-serif';

abstract class CanvasSprite {
  readonly sprite: THREE.Sprite;
  protected readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.SpriteMaterial;
  private disposed = false;

  constructor(scene: THREE.Scene, at: Vec3, w: number, h: number, metresWide: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, fog: false });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(metresWide, (metresWide * h) / w, 1);
    this.sprite.position.set(at.x, at.y, at.z);
    scene.add(this.sprite);
    // Web fonts may not be ready on the first draw.
    void document.fonts?.ready.then(() => this.redraw());
  }

  protected abstract draw(): void;

  redraw() {
    if (this.disposed) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.draw();
    this.tex.needsUpdate = true;
  }

  dispose(scene: THREE.Scene) {
    this.disposed = true;
    scene.remove(this.sprite);
    this.tex.dispose();
    this.mat.dispose();
  }
}

// A challenge sign: dark plate, accent bar, title, rules line, best line.
export class PadSign extends CanvasSprite {
  private text: SignText;

  constructor(scene: THREE.Scene, at: Vec3, text: SignText) {
    super(scene, at, 512, 256, 3.6);
    this.text = text;
    this.redraw();
  }

  set(text: SignText) {
    this.text = text;
    this.redraw();
  }

  protected draw() {
    const { ctx, canvas } = this;
    const { title, sub, foot, accent } = this.text;
    const W = canvas.width;
    const H = canvas.height;
    const c = 18; // chamfer
    ctx.beginPath();
    ctx.moveTo(c, 0);
    ctx.lineTo(W, 0);
    ctx.lineTo(W, H - c);
    ctx.lineTo(W - c, H);
    ctx.lineTo(0, H);
    ctx.lineTo(0, c);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 11, 16, 0.84)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    ctx.fillRect(28, 34, 8, 60);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 64px ${FONT_DISPLAY}`;
    ctx.fillText(title.toUpperCase(), 52, 88, W - 76);
    if (sub) {
      ctx.fillStyle = 'rgba(230, 236, 244, 0.78)';
      ctx.font = `500 27px ${FONT_BODY}`;
      ctx.fillText(sub, 30, 150, W - 60);
    }
    if (foot) {
      ctx.fillStyle = accent;
      ctx.font = `600 32px ${FONT_BODY}`;
      ctx.fillText(foot, 30, 214, W - 60);
    }
  }
}

// A short floating label ("20 m", "3").
export class Label extends CanvasSprite {
  constructor(scene: THREE.Scene, at: Vec3, private text: string, private color: string, metresWide = 1.6) {
    super(scene, at, 256, 128, metresWide);
    this.redraw();
  }

  setText(text: string, color = this.color) {
    if (text === this.text && color === this.color) return;
    this.text = text;
    this.color = color;
    this.redraw();
  }

  protected draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = 'rgba(8, 11, 16, 0.7)';
    ctx.fillRect(0, 18, canvas.width, canvas.height - 36);
    ctx.fillStyle = this.color;
    ctx.font = `700 68px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.text, canvas.width / 2, canvas.height / 2 + 4, canvas.width - 20);
  }
}
