import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

describe('user management API', () => {
  let app: INestApplication;
  let db: Database;
  const as = (email: string) => ({ authorization: `Bearer ${email}` });
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDatabase();
    app = await apiApp(testConfig(), new World(), new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'), ('ngozi.okafor@example.com', 'csm')`);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('tells the app who is an admin', async () => {
    expect((await http().get('/me').set(as('director@example.com')).expect(200)).body).toMatchObject({ role: 'cs_director', isAdmin: true });
    expect((await http().get('/me').set(as('ngozi.okafor@example.com')).expect(200)).body).toMatchObject({ isAdmin: false });
  });

  it('is for admins only', async () => {
    await http().get('/users').set(as('ngozi.okafor@example.com')).expect(403);
    await http().post('/users').set(as('ngozi.okafor@example.com')).send({ email: 'x@example.com', role: 'csm' }).expect(403);
    expect((await http().get('/users').set(as('director@example.com')).expect(200)).body).toHaveLength(3);
  });

  it('adds a user who can then sign in, in the company domain only', async () => {
    await http().get('/me').set(as('new.hire@example.com')).expect(403);
    await http().post('/users').set(as('director@example.com')).send({ email: 'New.Hire@example.com', role: 'support_specialist', name: 'New Hire' }).expect(201);
    expect((await http().get('/me').set(as('new.hire@example.com')).expect(200)).body.role).toBe('support_specialist');
    await http().post('/users').set(as('director@example.com')).send({ email: 'new.hire@example.com', role: 'csm' }).expect(409);
    const wrong = await http().post('/users').set(as('director@example.com')).send({ email: 'someone@gmail.com', role: 'csm' }).expect(400);
    expect(wrong.body.message).toMatch(/example\.com/);
    await http().post('/users').set(as('director@example.com')).send({ email: 'a@example.com', role: 'boss' }).expect(400);
    expect((await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action = 'user.invite'`)).rows[0]!.n).toBe(1);
  });

  it('changes roles, and deactivating blocks sign-in and notifications', async () => {
    await http().put('/users/ngozi.okafor@example.com').set(as('director@example.com')).send({ role: 'cs_team_lead' }).expect(200);
    expect((await http().get('/me').set(as('ngozi.okafor@example.com'))).body.role).toBe('cs_team_lead');
    await http().put('/users/ngozi.okafor@example.com').set(as('director@example.com')).send({ active: false }).expect(200);
    const blocked = await http().get('/me').set(as('ngozi.okafor@example.com')).expect(403);
    expect(blocked.body.message).toMatch(/deactivated/);
    await http().put('/users/ngozi.okafor@example.com').set(as('director@example.com')).send({ active: true }).expect(200);
    await http().get('/me').set(as('ngozi.okafor@example.com')).expect(200);
    await http().put('/users/nobody@example.com').set(as('director@example.com')).send({ role: 'csm' }).expect(404);
    await http().put('/users/ngozi.okafor@example.com').set(as('director@example.com')).send({}).expect(400);
  });

  it('keeps super admin power with super admins, and never locks everyone out', async () => {
    await http().post('/users').set(as('director@example.com')).send({ email: 'boss@example.com', role: 'super_admin' }).expect(403);
    await http().put('/users/ngozi.okafor@example.com').set(as('director@example.com')).send({ role: 'super_admin' }).expect(403);
    await http().put('/users/admin@example.com').set(as('director@example.com')).send({ active: false }).expect(403);
    await http().put('/users/admin@example.com').set(as('admin@example.com')).send({ active: false }).expect(403); // not yourself
    await db.query(`INSERT INTO app_user (email, role) VALUES ('second@example.com', 'super_admin')`);
    await http().put('/users/second@example.com').set(as('admin@example.com')).send({ active: false }).expect(200);
    await http().put('/users/director@example.com').set(as('director@example.com')).send({ role: 'csm' }).expect(403);
    await db.query(`UPDATE app_user SET role = 'cs_director' WHERE email = 'second@example.com'`);
    await db.query(`INSERT INTO app_user (email, role) VALUES ('third@example.com', 'super_admin')`);
    await db.query(`UPDATE app_user SET active = false WHERE email = 'admin@example.com'`);
    // third is now the only active super admin; demoting them is refused
    await http().put('/users/third@example.com').set(as('third@example.com')).send({ role: 'csm' }).expect(403); // self
  });
});
