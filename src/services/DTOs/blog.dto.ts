import { IsNotEmpty, Length, IsMongoId, IsOptional } from 'class-validator';

export class CreateBlogDto {
  @IsNotEmpty()
  @Length(3, 100)
  title: string;

  @IsNotEmpty()
  @Length(10, 5000)
  content: string;

  @IsNotEmpty()
  @IsMongoId()
  author: string;

  constructor(title: string, content: string, author: string) {
    this.title = title;
    this.content = content;
    this.author = author;
  }
}

export class UpdateBlogDto {
  @IsOptional()
  @Length(3, 100)
  title?: string;

  @IsOptional()
  @Length(10, 5000)
  content?: string;

  @IsOptional()
  @IsMongoId()
  author?: string;

  constructor(title?: string, content?: string, author?: string) {
    if (title) this.title = title;
    if (content) this.content = content;
    if (author) this.author = author;
  }
}
