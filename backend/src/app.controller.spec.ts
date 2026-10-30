import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('should return health status', () => {
      const res = appController.getHealth();
      expect(res.status).toBe('ok');
      expect(typeof res.timestamp).toBe('string');
    });

    it('should return api health status', () => {
      const res = appController.getApiHealth();
      expect(res.status).toBe('ok');
      expect(typeof res.timestamp).toBe('string');
    });
  });
});
