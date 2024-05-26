import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app';
import User from '../models/user.model';

describe('User Routes', () => {

  beforeAll(async () => {
    await User.create({
      username: 'testuser1',
      email: 'test_user_1@example.com',
      password: 'password123',
      role: 'admin'
    });

    await User.create({
      username: 'testuser2',
      email: 'test_user_2@example.com',
      password: 'password123',
      role: 'user'
    });
  });
  
  afterAll(async () => {
    await User.deleteMany({});
    await mongoose.connection.close();
  });

  it('should login an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_1@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('should not login with wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_1@example.com',
        password: 'wrongpassword',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('message', 'Invalid email or password');
  });

  it('should register a new user', async () => {

    const login = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_1@example.com',
        password: 'password123',
      });
    
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      })
      .set('Authorization', `Bearer ${login.body.token}`);
    
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
  });

  it('should not register a new user if no token is provided', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });
    
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'Not authorized, no token');
  });

  it('should not register a new user if invalid token is provided', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      })
      .set('Authorization', `Bearer randomsringsandintegers}`);
    
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('message', 'Not authorized, token failed');
  });

  it('should not register a new user if admin token is not provided', async () => {

    const login = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_2@example.com',
        password: 'password123',
      });
    
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      })
      .set('Authorization', `Bearer ${login.body.token}`);
    
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'Not authorized as an admin');
  });

  it('should not register a user with an existing email', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_1@example.com',
        password: 'password123',
      });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser2',
        email: 'test_user_1@example.com',
        password: 'password123',
      })
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('message', 'User already exists');
  });
});
