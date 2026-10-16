import { createBoothApp } from '../backend/app.js';

const booth = createBoothApp();

export default async function handler(request, response) {
  const { app } = await booth;
  return app(request, response);
}
