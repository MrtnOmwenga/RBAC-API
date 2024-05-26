import { Router, Request, Response } from 'express';
import { plainToClass } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import Blog from '../models/blog.model';
import { CreateBlogDto, UpdateBlogDto } from '../services/DTOs/blog.dto';
import { auth } from '../middleware/auth.middleware';
import { ObjectId } from 'mongodb';

const BlogRoutes: Router = Router();

BlogRoutes.post('/', auth, async (req: Request, res: Response) => {

  try {
    const createBlogDto = plainToClass(CreateBlogDto, req.body);
    const errors = await validateOrReject(createBlogDto);
  } catch (errors) {
    console.error('Validation error', errors);
    return res.status(400).json(errors);
  }

  const { title, content, author } = req.body;
  const blog = new Blog({
    title,
    content,
    author,
  });

  const createdBlog = await blog.save();
  res.status(201).json(createdBlog);
});

BlogRoutes.get('/', async (req: Request, res: Response) => {
  const blogs = await Blog.find();
  res.json(blogs);
});

BlogRoutes.get('/:id', async (req: Request, res: Response) => {
  const blog = await Blog.findById(req.params.id);

  if (blog) {
    res.json(blog);
  } else {
    res.status(404).json({ message: 'Blog not found' });
  }
});

BlogRoutes.put('/:id', auth, async (req: Request, res: Response) => {

  try {
    const updateBlogDto = plainToClass(UpdateBlogDto, req.body);
    const errors = await validateOrReject(updateBlogDto);
  } catch (errors) {
    console.error('Validation error', errors);
    return res.status(400).json(errors);
  }

  const blog = await Blog.findById(req.params.id);
  const { title, content, author } = req.body;
  if (blog) {
    blog.title = title || blog.title;
    blog.content = content || blog.content;
    blog.author = author || blog.author;

    const updatedBlog = await blog.save();
    res.json(updatedBlog);
  } else {
    res.status(404).json({ message: 'Blog not found' });
  }
});

BlogRoutes.delete('/:id', auth, async (req: Request, res: Response) => {
  const blog = await Blog.findById(req.params.id);

  if (blog) {
    await Blog.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ message: 'Blog removed' });
  } else {
    res.status(404).json({ message: 'Blog not found' });
  }
});

export default BlogRoutes;
