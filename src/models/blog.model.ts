import { prop, Ref, getModelForClass } from '@typegoose/typegoose';
import { User } from './user.model';

export class Blog {
  @prop({ required: true })
  title!: string;

  @prop({ required: true })
  content!: string;

  @prop({ ref: () => User, required: true })
  author!: Ref<User>;
}

const BlogModel = getModelForClass(Blog);
export default BlogModel;
