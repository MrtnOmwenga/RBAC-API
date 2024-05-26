import { prop, pre, getModelForClass, DocumentType } from '@typegoose/typegoose';
import { Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';

@pre<User>('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
})

export class User {
  @prop({ required: true, unique: true })
  username!: string;

  @prop({ required: true, unique: true })
  email!: string;

  @prop({ required: true })
  password!: string;

  @prop({ enum: ['admin', 'user'], default: 'user' })
  role!: 'admin' | 'user';

  public async matchPassword(this: DocumentType<User>, password: string): Promise<boolean> {
    return await bcrypt.compare(password, this.password);
  }
}

const UserModel = getModelForClass(User, {
  existingMongoose: undefined,
  schemaOptions: {
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
      },
    },
  },
});

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
}

export default UserModel;
