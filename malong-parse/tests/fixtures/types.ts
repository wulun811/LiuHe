// TypeScript types example

interface User {
  id: number;
  name: string;
  email: string;
}

type UserRole = 'admin' | 'user' | 'guest';

interface AdminUser extends User {
  role: UserRole;
  permissions: string[];
}

class UserService {
  private users: Map<number, User> = new Map();

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(id: number): User | undefined {
    return this.users.get(id);
  }

  removeUser(id: number): boolean {
    return this.users.delete(id);
  }
}

function createUser(id: number, name: string, email: string): User {
  return { id, name, email };
}

function isAdmin(user: User): user is AdminUser {
  return 'role' in user && user.role === 'admin';
}
