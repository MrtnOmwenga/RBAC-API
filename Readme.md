## RBAC-API

This is a Node.js application for managing blogs with role-based access control (RBAC) implemented. It provides RESTful API endpoints for creating, reading, updating, and deleting blog posts. The application uses TypeScript and MongoDB for data storage.


### Features

Role-based access control (RBAC) with two roles: admin and user.

Administrators can perform CRUD operations on blogs and create new users.

Users can read and write blogs.

Basic authentication with JWT tokens.

MongoDB database for storing user and blog information.


### Technologies Used

Node.js

TypeScript

Express.js

MongoDB

JWT for authentication

Class-validator for input validation

Class-transformer for transforming DTOs

Jest for testing


### Getting Started

To get started with the application, follow these steps:



1. Clone the repository:

```
git clone https://github.com/MrtnOmwenga/RBAC-API.git
```

2. Install dependencies:

```
cd blog-management-app
npm install
```

3. Set up environment variables:

Create a .env file in the root directory and add the following variables:

```
MONGODB_URI=<your-mongodb-uri>
JWT_SECRET=<your-jwt-secret>
PORT=<port-number>
```

4. Run the application:

```
npm start
```

You can now access the API endpoints using a tool like Postman or curl.


### API Endpoints

POST `/api/auth/register`: Register a new user.

POST `/api/auth/login`: Login with existing user credentials.

GET `/api/blogs`: Get all blogs.

GET `/api/blogs/:id`: Get a specific blog by ID.

POST `/api/blogs`: Create a new blog.

PUT `/api/blogs/:id`: Update an existing blog by ID.

DELETE `/api/blogs/:id`: Delete an existing blog by ID.


### Testing

The application comes with test cases to ensure its correctness and reliability. To run the tests, use the following command:

```
npm test
```

### Contributing

Contributions are welcome! Feel free to submit pull requests or open issues if you encounter any problems or have suggestions for improvements.


### License

This project is licensed under the MIT License.
