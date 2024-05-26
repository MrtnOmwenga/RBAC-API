import { Router, Request, Response } from 'express';
import { plainToClass } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import UserModel from '../models/user.model';
import generateToken from '../services/token.service';
import { auth, admin } from '../middleware/auth.middleware';
import { CreateUserDto, LoginUserDto } from '../services/DTOs/user.dto';

const UserRoutes: Router = Router();

UserRoutes.post('/register', auth, admin, async (req: Request, res: Response) => {

  try {
    const createUserDto = plainToClass(CreateUserDto, req.body);
    await validateOrReject(createUserDto)
  } catch (errors) {
    console.error('Validation error', errors);
    return res.status(400).json(errors);
  }

  const { username, email, password } = req.body;
  const userExists = await UserModel.findOne({ email });

  if (userExists) {
    return res.status(400).json({ message: 'User already exists' });
  }

  const user = await UserModel.create({ username, email, password });

  if (user) {
    res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      token: generateToken(user.id.toString()),
    });
  } else {
    res.status(400).json({ message: 'Invalid user data' });
  }
});

UserRoutes.post('/login', async (req: Request, res: Response) => {

  try {
    const loginUserDto = plainToClass(LoginUserDto, req.body);
    await validateOrReject(loginUserDto);
  } catch (errors) {
    console.error('Validation error', errors);
    return res.status(400).json(errors);
  }

  const { email, password } = req.body;
  const user = await UserModel.findOne({ email });

  if (user && await user.matchPassword(password)) {
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      token: generateToken(user.id.toString()),
    });
  } else {
    res.status(401).json({ message: 'Invalid email or password' });
  }
});

export default UserRoutes;
