const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create contracts subdirectory
const contractsDir = path.join(uploadsDir, 'contracts');
if (!fs.existsSync(contractsDir)) {
  fs.mkdirSync(contractsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, contractsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: timestamp-random-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `contract-${uniqueSuffix}-${sanitizedName}`);
  }
});

// File filter to only allow Word docs and PDFs
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  
  const allowedExtensions = ['.pdf', '.doc', '.docx'];
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(fileExtension)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF and Word documents (.pdf, .doc, .docx) are allowed'), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// File upload service functions
const fileUploadService = {
  // Single file upload middleware
  uploadContractFile: upload.single('contractFile'),
  
  // Delete file function
  deleteFile: (filePath) => {
    return new Promise((resolve, reject) => {
      if (!filePath) {
        return resolve();
      }
      
      const fullPath = path.join(__dirname, '../', filePath);
      fs.unlink(fullPath, (err) => {
        if (err && err.code !== 'ENOENT') {
          // ENOENT means file doesn't exist, which is fine
          console.error('Error deleting file:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },
  
  // Get file info
  getFileInfo: (req) => {
    if (!req.file) return null;
    
    return {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path.replace(path.join(__dirname, '../'), ''), // Store relative path
      size: req.file.size,
      mimetype: req.file.mimetype
    };
  },
  
  // Validate file exists
  fileExists: (filePath) => {
    if (!filePath) return false;
    const fullPath = path.join(__dirname, '../', filePath);
    return fs.existsSync(fullPath);
  },
  
  // Get download stream
  getFileStream: (filePath) => {
    const fullPath = path.join(__dirname, '../', filePath);
    return fs.createReadStream(fullPath);
  }
};

module.exports = fileUploadService;