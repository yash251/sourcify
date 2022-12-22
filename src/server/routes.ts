import { Router } from "express";
import config from "../config";
import { FileService } from "@ethereum-sourcify/core";
import VerificationService from "../services/VerificationService";
import { ValidationService } from "@ethereum-sourcify/validation";
import FileController from "./controllers/FileController";
import VerificationController from "./controllers/VerificationController";
import TestArtifactsController from "./controllers/TestArtifactsController";

export default async function loadRoutes() {
  const router: Router = Router();

  const fileService = new FileService(config.repository.path);
  const validationService: ValidationService = new ValidationService();
  const verificationService = await VerificationService.createAsync(
    fileService,
    {
      web3timeout: 3000,
    }
  );

  const testArtifactsController = new TestArtifactsController();
  const fileController = new FileController(fileService);
  const verificationController: VerificationController =
    new VerificationController(verificationService, validationService);

  await verificationController.router.use(
    "/chain-tests",
    testArtifactsController.registerRoutes()
  );
  router.use("/files/", fileController.registerRoutes());
  router.use("/", verificationController.registerRoutes());
  return router;
}
