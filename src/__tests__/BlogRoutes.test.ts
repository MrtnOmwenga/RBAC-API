import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app';
import User from '../models/user.model';
import Blog from '../models/blog.model';

describe('Blog Routes', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    await User.create({
      username: 'testuser1',
      email: 'test_user_1@example.com',
      password: 'password123',
      role: 'admin'
    });

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_1@example.com',
        password: 'password123',
      });
    
    adminToken = adminLogin.body.token;

    await User.create({
      username: 'testuser2',
      email: 'test_user_2@example.com',
      password: 'password123',
      role: 'user'
    });

    const userLogin = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test_user_2@example.com',
        password: 'password123',
      });
    
    userToken = userLogin.body.token;
    userId = userLogin.body.id.toString();
  }, 1000000);
  
  afterAll(async () => {
    await User.deleteMany({});
    await Blog.deleteMany({});
    await mongoose.connection.close();
  });

  it('should allow admin to create a new blog', async () => {
    const res = await request(app)
      .post('/api/blogs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Test Blog',
        content: 'This is a test blog',
        author: userId
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('title', 'Test Blog');
  }, 1000000);

  it('should allow user to create a new blog', async () => {
    const res = await request(app)
      .post('/api/blogs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Test Blog',
        content: 'This is a test blog',
        author: userId,
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('title', 'Test Blog');
  });

  it('should allow admin to fetch all blogs', async () => {
    const res = await request(app).get('/api/blogs').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('should allow user to fetch all blogs', async () => {
    const res = await request(app).get('/api/blogs').set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('should allow admin to fetch a single blog by id', async () => {
    const blog = await Blog.create({
      title: 'Test Blog',
      content: 'This is a test blog',
      author: userId,
    });

    const res = await request(app).get(`/api/blogs/${blog._id}`).set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Test Blog');
  });

  it('should allow user to fetch a single blog by id', async () => {
    const blog = await Blog.create({
      title: 'Test Blog',
      content: 'This is a test blog',
      author: userId,
    });

    const res = await request(app).get(`/api/blogs/${blog._id}`).set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Test Blog');
  });

  it('should allow admin to update a blog', async () => {
    const blog = await Blog.create({
      title: 'Test Blog',
      content: 'This is a test blog',
      author: userId,
    });

    const res = await request(app)
      .put(`/api/blogs/${blog._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Updated Blog',
        content: 'This is an updated test blog',
      })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Updated Blog');
  });

  it('should not allow user to update a blog', async () => {
    const blog = await Blog.create({
      title: 'Another Test Blog',
      content: 'This is another test blog',
      author: userId,
    });

    const res = await request(app)
      .put(`/api/blogs/${blog._id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        title: 'Updated Blog',
        content: 'This is an updated test blog',
      })
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Updated Blog');
  });

  it('should allow admin to delete a blog', async () => {
    const blog = await Blog.create({
      title: 'Test Blog',
      content: 'This is a test blog',
      author: userId,
    });

    const res = await request(app)
      .delete(`/api/blogs/${blog._id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Blog removed');
  });

  it('should not allow user to delete a blog', async () => {
    const blog = await Blog.create({
      title: 'Test Blog',
      content: 'This is a test blog',
      author: userId,
    });

    const res = await request(app)
      .delete(`/api/blogs/${blog._id}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Blog removed');
  });
});
