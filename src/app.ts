import express from 'express';
import mongoose from 'mongoose';
import UserRoutes from './controllers/user.controller';
import BlogRoutes from './controllers/blog.controller';
import config from './utils/config.utils';

const app = express();
app.use(express.json());

app.use('/api/auth', UserRoutes);
app.use('/api/blogs', BlogRoutes);

mongoose.connect(config.MONGODB_URI!).then(() => {
  console.log('MongoDB connected');
}).catch(error => {
  console.error(`Error connecting to MongoDB: ${error.message}`);
});

export default app;
