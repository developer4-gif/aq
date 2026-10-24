export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.expose = true; Object.assign(this, extra); }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = "Not found.") => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
